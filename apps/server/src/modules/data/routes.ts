import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { SqlServerConnection } from '@hustserver/engine';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { runQuery } from './query.js';

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
  app.post('/api/data/query', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string; query?: string; limit?: number };
    if (!body.connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    if (!body.query?.trim()) return reply.code(400).send({ error: '缺少 SQL 语句' });
    const row = repo.findById(body.connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.role === 'admin' || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as unknown as SqlServerConnection;
    try {
      return await runQuery(conn, body.query.trim(), body.limit);
    } catch (err) {
      return reply.code(400).send({ error: '执行 SQL 失败', detail: (err as Error).message });
    }
  });
}
