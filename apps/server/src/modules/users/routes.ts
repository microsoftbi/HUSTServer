import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import type { LoginLogsRepo } from '../auth/loginLogs.js';
import { hashPassword } from '../auth/password.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { isRole, type Role } from './roles.js';
import type { UserRow, UsersRepo, UserStatus } from './repo.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;
const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 100;

function publicUser(u: UserRow, roles: Role[]) {
  return { id: u.id, username: u.username, roles, status: u.status, created_at: u.created_at, updated_at: u.updated_at };
}

function parseRoles(v: unknown): Role[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((r) => isRole(r))) return null;
  return Array.from(new Set(v));
}

function isStatus(v: unknown): v is UserStatus {
  return v === 'active' || v === 'disabled';
}

export interface UserAdminDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
  loginLogs: LoginLogsRepo;
}

export function userAdminRoutes(app: FastifyInstance, deps: UserAdminDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.get('/api/admin/users', { preHandler: [auth, requireAdmin] }, async () =>
    deps.users.list().map((u) => publicUser(u, deps.users.rolesOf(u.id))),
  );

  app.post('/api/admin/users', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { username, password, roles: rawRoles } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      roles?: unknown;
    };
    if (!username || !USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: '用户名需为 3-32 位字母、数字、_ . -' });
    }
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return reply.code(400).send({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    const roles = parseRoles(rawRoles);
    if (!roles) return reply.code(400).send({ error: 'roles 必须为非空且合法的角色数组' });
    if (deps.users.findByUsername(username)) return reply.code(409).send({ error: '用户名已存在' });
    const created = deps.users.create({ username, passwordHash: await hashPassword(password), roles });
    return reply.code(201).send(publicUser(created, roles));
  });

  app.get('/api/admin/users/:id/login-logs', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit: rawLimit } = req.query as { limit?: string };
    let limit = DEFAULT_LOG_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LOG_LIMIT) {
        return reply.code(400).send({ error: `limit 需为 1-${MAX_LOG_LIMIT} 的整数` });
      }
      limit = parsed;
    }
    if (!deps.users.findById(id)) return reply.code(404).send({ error: '用户不存在' });
    return {
      logs: deps.loginLogs.listByUser(id, limit).map((l) => ({
        id: l.id,
        success: l.success === 1,
        reason: l.reason,
        ip: l.ip,
        user_agent: l.user_agent,
        created_at: l.created_at,
      })),
    };
  });

  app.put('/api/admin/users/:id', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { roles: rawRoles, status } = (req.body ?? {}) as { roles?: unknown; status?: unknown };
    let roles: Role[] | undefined;
    if (rawRoles !== undefined) {
      const parsed = parseRoles(rawRoles);
      if (!parsed) return reply.code(400).send({ error: 'roles 必须为非空且合法的角色数组' });
      roles = parsed;
    }
    if (status !== undefined && !isStatus(status)) return reply.code(400).send({ error: 'status 非法' });
    if (id === req.auth!.userId && status === 'disabled') {
      return reply.code(400).send({ error: '不能禁用当前登录账号' });
    }
    const updated = deps.users.update(id, { roles, status: status as UserStatus | undefined });
    if (!updated) return reply.code(404).send({ error: '用户不存在' });
    if (status === 'disabled') deps.sessions.removeByUser(id);
    return publicUser(updated, deps.users.rolesOf(id));
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
