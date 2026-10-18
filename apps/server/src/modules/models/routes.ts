import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { AuditRecorder } from '../audit/repo.js';
import { connectionsRepo } from '../connections/repo.js';
import { isAllowedResourceFile, resolveResourcePath } from '../resources/paths.js';
import type { UsersRepo } from '../users/repo.js';
import { dataModelsRepo } from './repo.js';
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
    items: repo.list().map((r) => ({
      name: r.name,
      sourceKind: r.source_kind,
      sourceRef: JSON.parse(r.source_ref) as unknown,
      ownerId: r.owner_id,
      loadedAt: r.loaded_at,
      rowCount: r.row_count,
      columns: JSON.parse(r.columns) as unknown,
    })),
  }));

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
