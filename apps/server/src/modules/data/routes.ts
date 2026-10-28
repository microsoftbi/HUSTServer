import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { SqlServerConnection } from '@hustserver/engine';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { listTables, runQuery } from './query.js';
import {
  parseAggregateSpec,
  runAggregateOnSqlServer,
  runDistinctOnSqlServer,
} from './aggregate.js';

export interface DataRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

export function dataRoutes(app: FastifyInstance, deps: DataRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = connectionsRepo(deps.db);

  // 仪表板专用取数：可见即可用（admin / 共享 / 自有连接）；不做只读校验，仅做行数截断。
  app.post('/api/data/query', { preHandler: [auth, requireCap('connection.use')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string; query?: string; limit?: number };
    if (!body.connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    if (!body.query?.trim()) return reply.code(400).send({ error: '缺少 SQL 语句' });
    const row = repo.findById(body.connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return await runQuery(conn, body.query.trim(), body.limit);
    } catch (err) {
      return reply.code(400).send({ error: '执行 SQL 失败', detail: (err as Error).message });
    }
  });

  // 列出连接所在库中的表/视图，供仪表板选择数据表来源。
  app.post('/api/data/tables', { preHandler: [auth, requireCap('connection.use')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string };
    if (!body.connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    const row = repo.findById(body.connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return { tables: await listTables(conn) };
    } catch (err) {
      return reply.code(400).send({ error: '获取数据表失败', detail: (err as Error).message });
    }
  });

  /** 聚合下推：把用户 SQL 包成子查询，在库内完成分组与聚合（权限校验同 /api/data/query）。 */
  app.post('/api/data/aggregate', { preHandler: [auth, requireCap('connection.use')] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
    if (!connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return reply.code(400).send({ error: '缺少 SQL 语句' });
    const parsed = parseAggregateSpec(body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const row = repo.findById(connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return await runAggregateOnSqlServer(conn, query, parsed.spec);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '聚合失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  /** 去重值：截断数据集上切片器/筛选器的候选值需要覆盖全量行。 */
  app.post('/api/data/distinct', { preHandler: [auth, requireCap('connection.use')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: unknown; query?: unknown; field?: unknown; limit?: unknown };
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
    if (!connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return reply.code(400).send({ error: '缺少 SQL 语句' });
    const field = typeof body.field === 'string' ? body.field.trim() : '';
    if (!field) return reply.code(400).send({ error: '缺少列名' });
    const row = repo.findById(connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return await runDistinctOnSqlServer(conn, query, field, typeof body.limit === 'number' ? body.limit : 200);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '读取列值失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
