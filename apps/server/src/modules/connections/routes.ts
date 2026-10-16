import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { decryptConfig, encryptConfig, maskConnection } from './crypto.js';
import { listSqlServerDatabases, listSqlServerObjects, testTcp } from './probe.js';
import { connectionsRepo, type ConnectionRow } from './repo.js';

export interface ConnectionRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

function toDto(row: ConnectionRow, cfg: AppConfig) {
  return {
    id: row.id, name: row.name, type: row.type, shared: row.shared === 1,
    owner_id: row.owner_id, updated_at: row.updated_at,
    config: maskConnection(decryptConfig(row.config_encrypted, cfg.encryptionKey)),
  };
}

export function connectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = connectionsRepo(deps.db);
  const canManage = (req: Parameters<typeof auth>[0], row: ConnectionRow) =>
    req.auth!.caps.has('admin') || row.owner_id === req.auth!.userId;
  // 「可见即可用」：管理员、共享连接、或自有连接都可在工作流中引用。
  const canUse = (req: Parameters<typeof auth>[0], row: ConnectionRow) =>
    req.auth!.caps.has('admin') || row.shared === 1 || row.owner_id === req.auth!.userId;

  app.get('/api/connections', { preHandler: [auth, requireCap('connection.use')] }, async (req) => {
    const rows = req.auth!.caps.has('admin') ? repo.listAll() : repo.listForOwner(req.auth!.userId);
    return rows.map((r) => toDto(r, deps.config));
  });

  app.post('/api/connections', { preHandler: [auth, requireCap('connection.manage')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; type?: string; config?: Record<string, unknown>; shared?: boolean };
    if (!body.name?.trim()) return reply.code(400).send({ error: '缺少连接名称' });
    if (!body.config || typeof body.config !== 'object') return reply.code(400).send({ error: '缺少连接配置' });
    const shared = body.shared === true && req.auth!.caps.has('admin');
    const row = repo.create({
      ownerId: shared ? null : req.auth!.userId,
      name: body.name.trim(),
      type: body.type ?? 'sqlserver',
      configEncrypted: encryptConfig(body.config, deps.config.encryptionKey),
      shared,
    });
    return reply.code(201).send(toDto(row, deps.config));
  });

  app.put('/api/connections/:id', { preHandler: [auth, requireCap('connection.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权修改该连接' });
    const body = (req.body ?? {}) as { name?: string; config?: Record<string, unknown>; shared?: boolean };
    const updated = repo.update(id, {
      name: body.name?.trim(),
      configEncrypted: body.config ? encryptConfig(body.config, deps.config.encryptionKey) : undefined,
      shared: req.auth!.caps.has('admin') ? body.shared : undefined,
    });
    return toDto(updated!, deps.config);
  });

  app.delete('/api/connections/:id', { preHandler: [auth, requireCap('connection.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权删除该连接' });
    repo.remove(id);
    return { ok: true };
  });

  // 对请求体中的配置发起真实 mssql 连接，成功后返回可用数据库列表（用于弹窗中测试尚未保存的连接）
  app.post('/api/connections/test', { preHandler: [auth, requireCap('connection.manage')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { config?: Record<string, unknown> };
    if (!body.config || typeof body.config !== 'object') return reply.code(400).send({ error: '缺少连接配置' });
    const cfg = body.config;
    const server = String(cfg.server ?? '');
    if (!server) return reply.code(400).send({ error: '连接缺少 server' });
    return listSqlServerDatabases({
      server,
      port: Number(cfg.port) || 1433,
      database: String(cfg.database ?? ''),
      user: String(cfg.user ?? ''),
      password: String(cfg.password ?? ''),
    });
  });

  app.post('/api/connections/:id/test', { preHandler: [auth, requireCap('connection.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权测试该连接' });
    const cfg = decryptConfig(row.config_encrypted, deps.config.encryptionKey);
    const server = String(cfg.server ?? '');
    const port = Number(cfg.port ?? 1433);
    if (!server) return reply.code(400).send({ error: '连接缺少 server' });
    return testTcp(server, port);
  });

  // 列出指定连接自身数据库下的表/视图（供画布中选择表；可见即可用）。
  app.get('/api/connections/:id/objects', { preHandler: [auth, requireCap('connection.use')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canUse(req, row)) return reply.code(403).send({ error: '无权使用该连接' });
    const cfg = decryptConfig(row.config_encrypted, deps.config.encryptionKey);
    const server = String(cfg.server ?? '');
    if (!server) return reply.code(400).send({ error: '连接缺少 server' });
    const res = await listSqlServerObjects({
      server,
      port: Number(cfg.port ?? 1433),
      database: String(cfg.database ?? ''),
      user: String(cfg.user ?? ''),
      password: String(cfg.password ?? ''),
    });
    if (!res.ok) return reply.code(400).send({ error: '读取表列表失败', detail: res.error });
    return { objects: res.objects ?? [] };
  });
}
