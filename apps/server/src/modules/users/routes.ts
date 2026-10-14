import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import { hashPassword } from '../auth/password.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { Role, UserRow, UsersRepo, UserStatus } from './repo.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, role: u.role, status: u.status, created_at: u.created_at, updated_at: u.updated_at };
}

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'user';
}
function isStatus(v: unknown): v is UserStatus {
  return v === 'active' || v === 'disabled';
}

export interface UserAdminDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
}

export function userAdminRoutes(app: FastifyInstance, deps: UserAdminDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.get('/api/admin/users', { preHandler: [auth, requireAdmin] }, async () => deps.users.list().map(publicUser));

  app.post('/api/admin/users', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { username, password, role } = (req.body ?? {}) as { username?: string; password?: string; role?: unknown };
    if (!username || !USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: '用户名需为 3-32 位字母、数字、_ . -' });
    }
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return reply.code(400).send({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    if (!isRole(role)) return reply.code(400).send({ error: 'role 必须为 admin 或 user' });
    if (deps.users.findByUsername(username)) return reply.code(409).send({ error: '用户名已存在' });
    const created = deps.users.create({ username, passwordHash: await hashPassword(password), role });
    return reply.code(201).send(publicUser(created));
  });

  app.put('/api/admin/users/:id', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, status } = (req.body ?? {}) as { role?: unknown; status?: unknown };
    if (role !== undefined && !isRole(role)) return reply.code(400).send({ error: 'role 非法' });
    if (status !== undefined && !isStatus(status)) return reply.code(400).send({ error: 'status 非法' });
    if (id === req.auth!.userId && status === 'disabled') {
      return reply.code(400).send({ error: '不能禁用当前登录账号' });
    }
    const updated = deps.users.update(id, { role: role as Role | undefined, status: status as UserStatus | undefined });
    if (!updated) return reply.code(404).send({ error: '用户不存在' });
    if (status === 'disabled') deps.sessions.removeByUser(id);
    return publicUser(updated);
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return reply.code(400).send({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    const updated = deps.users.update(id, { passwordHash: await hashPassword(password) });
    if (!updated) return reply.code(404).send({ error: '用户不存在' });
    deps.sessions.removeByUser(id);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.auth!.userId) return reply.code(400).send({ error: '不能删除当前登录账号' });
    const removed = deps.users.remove(id);
    if (!removed) return reply.code(404).send({ error: '用户不存在' });
    return { ok: true };
  });
}
