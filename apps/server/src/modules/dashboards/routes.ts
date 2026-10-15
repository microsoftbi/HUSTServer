import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { dashboardsRepo, type DashboardRow } from './repo.js';

export interface DashboardRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function validatePayload(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'payload 必须是对象';
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_PAYLOAD_BYTES) return 'payload_too_large';
  return null;
}

function toDto(row: DashboardRow, withPayload: boolean) {
  return {
    id: row.id,
    name: row.name,
    shared: row.shared === 1,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(withPayload ? { payload: JSON.parse(row.payload) } : {}),
  };
}

export function dashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = dashboardsRepo(deps.db);
  const canManage = (req: Parameters<typeof auth>[0], row: DashboardRow) =>
    req.auth!.role === 'admin' || row.owner_id === req.auth!.userId;
  const canView = (req: Parameters<typeof auth>[0], row: DashboardRow) =>
    req.auth!.role === 'admin' || row.shared === 1 || row.owner_id === req.auth!.userId;

  app.get('/api/dashboards', { preHandler: auth }, async (req) => {
    const rows = req.auth!.role === 'admin' ? repo.listAll() : repo.listForOwner(req.auth!.userId);
    return rows.map((r) => toDto(r, false));
  });

  app.post('/api/dashboards', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; payload?: unknown; shared?: boolean };
    if (!body.name?.trim()) return reply.code(400).send({ error: '缺少仪表板名称' });
    const payloadErr = validatePayload(body.payload);
    if (payloadErr) return reply.code(payloadErr === 'payload_too_large' ? 413 : 400).send({ error: payloadErr });
    const row = repo.create({
      ownerId: req.auth!.userId,
      name: body.name.trim(),
      payload: JSON.stringify(body.payload),
      shared: body.shared === true && req.auth!.role === 'admin',
    });
    return reply.code(201).send(toDto(row, true));
  });

  app.get('/api/dashboards/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '仪表板不存在' });
    if (!canView(req, row)) return reply.code(403).send({ error: '无权查看该仪表板' });
    return toDto(row, true);
  });

  app.put('/api/dashboards/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '仪表板不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权修改该仪表板' });
    const body = (req.body ?? {}) as { name?: string; payload?: unknown; shared?: boolean };
    let payloadText: string | undefined;
    if (body.payload !== undefined) {
      const payloadErr = validatePayload(body.payload);
      if (payloadErr) return reply.code(payloadErr === 'payload_too_large' ? 413 : 400).send({ error: payloadErr });
      payloadText = JSON.stringify(body.payload);
    }
    const updated = repo.update(id, {
      name: body.name?.trim(),
      payload: payloadText,
      shared: req.auth!.role === 'admin' ? body.shared : undefined,
    });
    return toDto(updated!, true);
  });

  app.delete('/api/dashboards/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '仪表板不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权删除该仪表板' });
    repo.remove(id);
    return { ok: true };
  });
}
