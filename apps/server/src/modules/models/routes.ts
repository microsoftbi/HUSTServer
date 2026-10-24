import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { ColumnInfo } from '@hustserver/engine';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { AuditRecorder } from '../audit/repo.js';
import { connectionsRepo } from '../connections/repo.js';
import { isAllowedResourceFile, resolveResourcePath } from '../resources/paths.js';
import type { UsersRepo } from '../users/repo.js';
import {
  LOGICAL_COLUMN_TYPES,
  mergeColumnTypes,
  parseColumnTypeConfig,
  type LogicalColumnType,
  type StoredColumnType,
} from './columnTypes.js';
import { dataModelsRepo, modelColumnConfigsRepo, modelLabelsRepo } from './repo.js';
import {
  MODEL_NAME_RE,
  PIVOT_AGGS,
  type LoadModelConfig,
  type ModelStore,
  type PivotAgg,
  type PivotSpec,
} from './service.js';

export interface ModelRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  modelStore: ModelStore;
  audit: AuditRecorder;
}

/** 透视维度字段数上限（行、列各自） */
const MAX_PIVOT_FIELDS = 3;
/** 透视度量数上限 */
const MAX_PIVOT_VALUES = 4;
/** 筛选条件数上限 */
const MAX_PIVOT_FILTERS = 3;
/** 数据标签（Markdown）字符数上限 */
const MAX_LABEL_LENGTH = 20000;

/** 校验透视请求体：只做形状与白名单校验，字段是否存在交给服务层（需要模型列信息）。 */
function parsePivotBody(raw: unknown): { spec: PivotSpec } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '请求体必须是对象' };
  const body = raw as Record<string, unknown>;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { error: '缺少模型名' };

  const fields = (value: unknown, label: string): string[] | string => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return `${label}必须是字符串数组`;
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) return `${label}包含非法字段`;
      out.push(item.trim());
    }
    if (out.length > MAX_PIVOT_FIELDS) return `${label}最多 ${MAX_PIVOT_FIELDS} 个字段`;
    if (new Set(out).size !== out.length) return `${label}存在重复字段`;
    return out;
  };

  const rows = fields(body.rows, '行字段');
  if (typeof rows === 'string') return { error: rows };
  const columns = fields(body.columns, '列字段');
  if (typeof columns === 'string') return { error: columns };

  if (!Array.isArray(body.values) || body.values.length === 0) return { error: '至少需要一个数值字段' };
  if (body.values.length > MAX_PIVOT_VALUES) return { error: `数值字段最多 ${MAX_PIVOT_VALUES} 个` };
  const values: Array<{ field: string; agg: PivotAgg }> = [];
  for (const item of body.values) {
    if (!item || typeof item !== 'object') return { error: '数值字段格式不合法' };
    const v = item as Record<string, unknown>;
    const field = typeof v.field === 'string' ? v.field.trim() : '';
    if (!field) return { error: '数值字段缺少列名' };
    if (typeof v.agg !== 'string' || !PIVOT_AGGS.includes(v.agg as PivotAgg)) {
      return { error: `不支持的聚合方式：${String(v.agg)}` };
    }
    values.push({ field, agg: v.agg as PivotAgg });
  }

  const rawFilters = body.filters === undefined || body.filters === null ? [] : body.filters;
  if (!Array.isArray(rawFilters)) return { error: '筛选条件必须是数组' };
  if (rawFilters.length > MAX_PIVOT_FILTERS) return { error: `筛选条件最多 ${MAX_PIVOT_FILTERS} 个` };
  const filters: Array<{ field: string; values: string[] }> = [];
  for (const item of rawFilters) {
    if (!item || typeof item !== 'object') return { error: '筛选条件格式不合法' };
    const f = item as Record<string, unknown>;
    const field = typeof f.field === 'string' ? f.field.trim() : '';
    if (!field) return { error: '筛选条件缺少列名' };
    const list = f.values === undefined || f.values === null ? [] : f.values;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
      return { error: '筛选值必须是字符串数组' };
    }
    filters.push({ field, values: list as string[] });
  }

  const limit = typeof body.limit === 'number' ? body.limit : undefined;
  return { spec: { name, rows, columns, values, filters, ...(limit !== undefined ? { limit } : {}) } };
}

export function modelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = dataModelsRepo(deps.db);
  const columnConfigs = modelColumnConfigsRepo(deps.db);
  const labels = modelLabelsRepo(deps.db);
  const connections = connectionsRepo(deps.db);

  /** 直接从资源文件或 SQL Server 表载入模型（与 Job 的「加载成模型」步骤同一套 config 与校验）。 */
  app.post('/api/models', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const modelName = typeof body.modelName === 'string' ? body.modelName.trim() : '';
    if (!modelName || !MODEL_NAME_RE.test(modelName)) {
      return reply.code(400).send({ error: '模型名不合法' });
    }
    const isAdmin = req.auth!.caps.has('admin');
    const userId = req.auth!.userId;

    let cfg: LoadModelConfig;
    if (body.source === 'file') {
      const resourcePath = typeof body.resourcePath === 'string' ? body.resourcePath.trim() : '';
      if (!resourcePath) return reply.code(400).send({ error: '资源文件不可用' });
      let abs: string;
      try {
        abs = resolveResourcePath(deps.config.resourceDir, resourcePath);
      } catch {
        return reply.code(400).send({ error: '资源文件不可用' });
      }
      if (!isAllowedResourceFile(abs) || !fs.existsSync(abs)) {
        return reply.code(400).send({ error: '资源文件不可用' });
      }
      const format = body.format === 'csv' || body.format === 'excel' ? body.format : undefined;
      cfg = { source: 'file', modelName, resourcePath, ...(format ? { format } : {}) };
    } else if (body.source === 'sqlserver') {
      const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
      const conn = connectionId ? connections.findById(connectionId) : null;
      if (!connectionId || !conn || !(isAdmin || conn.shared === 1 || conn.owner_id === userId)) {
        return reply.code(400).send({ error: '连接不可用' });
      }
      const object = typeof body.object === 'string' ? body.object.trim() : '';
      if (!object) return reply.code(400).send({ error: '需要指定表' });
      cfg = { source: 'sqlserver', modelName, connectionId, object };
    } else {
      return reply.code(400).send({ error: '数据来源无效' });
    }

    try {
      const result = await deps.modelStore.load(cfg, userId);
      deps.audit.record({
        userId: req.auth!.userId,
        action: 'create',
        resource: 'model',
        resourceName: modelName,
        description: `载入了数据模型「${modelName}」`,
      });
      return reply.code(201).send({ name: modelName, rowCount: result.rowCount, columns: result.columns });
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '加载失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/models', { preHandler: [auth, requireCap('dashboard.view')] }, async () => ({
    items: repo.list().map((r) => {
      const overrides = parseColumnTypeConfig(columnConfigs.get(r.name)?.columns ?? null);
      return {
        name: r.name,
        sourceKind: r.source_kind,
        sourceRef: JSON.parse(r.source_ref) as unknown,
        ownerId: r.owner_id,
        loadedAt: r.loaded_at,
        rowCount: r.row_count,
        // 列类型配置优先，未配置的列保持 DuckDB 原始类型
        columns: mergeColumnTypes(JSON.parse(r.columns) as ColumnInfo[], overrides),
      };
    }),
  }));

  /** 列类型配置：返回原始类型与当前配置（configType 为 null 表示使用原始类型）。 */
  app.get(
    '/api/models/:name/column-config',
    { preHandler: [auth, requireCap('job')] },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const row = repo.findByName(name);
      if (!row) return reply.code(404).send({ error: '模型不存在' });
      const overrides = parseColumnTypeConfig(columnConfigs.get(name)?.columns ?? null);
      const columns = (JSON.parse(row.columns) as ColumnInfo[]).map((c) => ({
        name: c.name,
        type: c.type,
        configType: overrides[c.name] ?? null,
      }));
      return { name, columns };
    },
  );

  /** 保存列类型配置：type 为 null（或省略）表示恢复原始类型。 */
  app.put(
    '/api/models/:name/column-config',
    { preHandler: [auth, requireCap('job')] },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const row = repo.findByName(name);
      if (!row) return reply.code(404).send({ error: '模型不存在' });

      const body = (req.body ?? {}) as { columns?: unknown };
      if (!Array.isArray(body.columns)) return reply.code(400).send({ error: 'columns 必须是数组' });

      const known = new Set((JSON.parse(row.columns) as ColumnInfo[]).map((c) => c.name));
      const seen = new Set<string>();
      const items: StoredColumnType[] = [];
      for (const item of body.columns) {
        if (!item || typeof item !== 'object') {
          return reply.code(400).send({ error: '列配置格式不合法' });
        }
        const { name: colName, type } = item as Record<string, unknown>;
        if (typeof colName !== 'string' || !known.has(colName)) {
          return reply.code(400).send({ error: `未知列：${String(colName)}` });
        }
        if (seen.has(colName)) return reply.code(400).send({ error: `列「${colName}」重复` });
        seen.add(colName);
        // 空值表示使用原始类型（不保存）
        if (type === null || type === undefined || type === '') continue;
        if (typeof type !== 'string' || !LOGICAL_COLUMN_TYPES.includes(type as LogicalColumnType)) {
          return reply.code(400).send({ error: `不支持的类型：${String(type)}` });
        }
        items.push({ name: colName, type: type as LogicalColumnType });
      }

      if (items.length === 0) columnConfigs.remove(name);
      else columnConfigs.save(name, JSON.stringify(items));

      deps.audit.record({
        userId: req.auth!.userId,
        action: 'update',
        resource: 'model',
        resourceName: name,
        description: `更新了数据模型「${name}」的列类型配置（${items.length} 列）`,
      });
      return { ok: true, count: items.length };
    },
  );

  /** 数据标签：读取该模型的 Markdown 说明（无标签时返回空串）。 */
  app.get('/api/models/:name/label', { preHandler: [auth, requireCap('dashboard.view')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    const row = labels.get(name);
    return { name, content: row?.content ?? '', updatedAt: row?.updated_at ?? null };
  });

  /** 数据标签：保存 Markdown 说明；内容为空白时删除标签。 */
  app.put('/api/models/:name/label', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });

    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== 'string') return reply.code(400).send({ error: 'content 必须是字符串' });
    if (body.content.length > MAX_LABEL_LENGTH) {
      return reply.code(400).send({ error: `标签内容过长（最多 ${MAX_LABEL_LENGTH} 字）` });
    }

    const hasLabel = body.content.trim() !== '';
    if (hasLabel) labels.save(name, body.content);
    else labels.remove(name);

    deps.audit.record({
      userId: req.auth!.userId,
      action: 'update',
      resource: 'model',
      resourceName: name,
      description: hasLabel ? `更新了数据模型「${name}」的数据标签` : `清空了数据模型「${name}」的数据标签`,
    });
    return { ok: true, hasLabel };
  });

  app.post('/api/models/query', { preHandler: [auth, requireCap('dashboard.view')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; limit?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: '缺少模型名' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    try {
      return await deps.modelStore.query(name, limit);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '读取模型失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/models/pivot', { preHandler: [auth, requireCap('dashboard.view')] }, async (req, reply) => {
    const parsed = parsePivotBody(req.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (!repo.findByName(parsed.spec.name)) return reply.code(404).send({ error: '模型不存在' });
    try {
      return await deps.modelStore.pivot(parsed.spec);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '透视失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/models/distinct', { preHandler: [auth, requireCap('dashboard.view')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; field?: unknown; limit?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: '缺少模型名' });
    const field = typeof body.field === 'string' ? body.field.trim() : '';
    if (!field) return reply.code(400).send({ error: '缺少列名' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    try {
      return await deps.modelStore.distinctValues(name, field, limit);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '读取列值失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/models/stats', { preHandler: [auth, requireCap('dashboard.view')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: '缺少模型名' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    try {
      return await deps.modelStore.stats(name);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '统计失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/models/:name', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { newName?: unknown };
    const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
    if (!newName) return reply.code(400).send({ error: '缺少新模型名' });
    if (!MODEL_NAME_RE.test(newName)) return reply.code(400).send({ error: '模型名不合法' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    if (repo.findByName(newName)) return reply.code(409).send({ error: '模型名已存在' });
    await deps.modelStore.rename(name, newName);
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'update',
      resource: 'model',
      resourceName: newName,
      description: `重命名了数据模型「${name}」为「${newName}」`,
    });
    return { ok: true };
  });

  app.delete('/api/models/:name', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    await deps.modelStore.remove(name);
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'delete',
      resource: 'model',
      resourceName: name,
      description: `删除了数据模型「${name}」`,
    });
    return { ok: true };
  });
}
