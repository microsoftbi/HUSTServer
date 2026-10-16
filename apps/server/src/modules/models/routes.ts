import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { dataModelsRepo } from './repo.js';
import { MODEL_NAME_RE, type ModelStore } from './service.js';

export interface ModelRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  modelStore: ModelStore;
}

export function modelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = dataModelsRepo(deps.db);

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

  app.patch('/api/models/:name', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { newName?: unknown };
    const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
    if (!newName) return reply.code(400).send({ error: '缺少新模型名' });
    if (!MODEL_NAME_RE.test(newName)) return reply.code(400).send({ error: '模型名不合法' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    if (repo.findByName(newName)) return reply.code(409).send({ error: '模型名已存在' });
    await deps.modelStore.rename(name, newName);
    return { ok: true };
  });

  app.delete('/api/models/:name', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    await deps.modelStore.remove(name);
    return { ok: true };
  });
}
