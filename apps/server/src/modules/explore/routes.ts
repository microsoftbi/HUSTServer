import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { SqlServerConnection } from '@hustserver/engine';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { runQuery } from '../data/query.js';
import { dataModelsRepo } from '../models/repo.js';
import type { ModelStore } from '../models/service.js';
import type { UsersRepo } from '../users/repo.js';
import { EXPLORE_TIMEOUT_MS, listColumns } from './query.js';
import { checkReadOnly } from './sqlGuard.js';

export interface ExploreRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  modelStore: ModelStore;
}

/**
 * 数据探索：左侧列出表/视图与列，右侧执行只读 SQL。
 * 入口能力统一为「连接使用」（connection.use），连接与模型两类数据源共用。
 */
export function exploreRoutes(app: FastifyInstance, deps: ExploreRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const guard = [auth, requireCap('connection.use')];
  const connections = connectionsRepo(deps.db);
  const models = dataModelsRepo(deps.db);

  /** 数据源：数据模型清单（模型名即 DuckDB 表名，含列信息） */
  app.get('/api/explore/models', { preHandler: guard }, async () => ({
    items: models.list().map((m) => ({
      name: m.name,
      rowCount: m.row_count,
      columns: JSON.parse(m.columns) as Array<{ name: string; type: string }>,
    })),
  }));

  /** 连接库中某张表/视图的列信息 */
  app.post('/api/explore/columns', { preHandler: guard }, async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string; schema?: string; name?: string };
    if (!body.connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    if (!body.name?.trim()) return reply.code(400).send({ error: '缺少表名' });
    const row = connections.findById(body.connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return { columns: await listColumns(conn, body.schema?.trim() || 'dbo', body.name.trim()) };
    } catch (err) {
      return reply.code(400).send({ error: '读取列信息失败', detail: (err as Error).message });
    }
  });

  /** 执行只读 SQL：source=connection 走 SQL Server，source=model 走模型库（DuckDB） */
  app.post('/api/explore/query', { preHandler: guard }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      source?: string;
      connectionId?: string;
      sql?: string;
      limit?: number;
    };
    const sqlText = typeof body.sql === 'string' ? body.sql.trim() : '';
    if (!sqlText) return reply.code(400).send({ error: '缺少 SQL 语句' });
    const check = checkReadOnly(sqlText);
    if (!check.ok) return reply.code(400).send({ error: check.reason });
    if (body.source !== 'connection' && body.source !== 'model') {
      return reply.code(400).send({ error: 'source 必须为 connection 或 model' });
    }

    if (body.source === 'model') {
      try {
        return await deps.modelStore.rawQuery(sqlText, body.limit);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: '执行查询失败', detail: err instanceof Error ? err.message : String(err) });
      }
    }

    if (!body.connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    const row = connections.findById(body.connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return await runQuery(conn, sqlText, body.limit, EXPLORE_TIMEOUT_MS);
    } catch (err) {
      return reply.code(400).send({ error: '执行 SQL 失败', detail: (err as Error).message });
    }
  });
}
