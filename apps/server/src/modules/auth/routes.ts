import type { FastifyInstance } from 'fastify';
import { verifyPassword } from './password.js';
import type { SessionsRepo } from './sessions.js';
import { requireAuth, SESSION_COOKIE } from '../../plugins/guards.js';
import type { UsersRepo } from '../users/repo.js';

export interface AuthRouteDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
  sessionTtlMs: number;
}

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: '缺少用户名或密码' });
    const user = deps.users.findByUsername(username);
    if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const sess = deps.sessions.create(user.id, deps.sessionTtlMs);
    reply.setCookie(SESSION_COOKIE, sess.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(deps.sessionTtlMs / 1000),
    });
    return { id: user.id, username: user.username, role: user.role };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deps.sessions.remove(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: guard }, async (req) => ({
    id: req.auth!.userId,
    username: req.auth!.username,
    role: req.auth!.role,
  }));
}
