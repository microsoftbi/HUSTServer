import type { FastifyInstance } from 'fastify';
import type { AuditRecorder } from '../audit/repo.js';
import { verifyPassword } from './password.js';
import type { LoginLogsRepo } from './loginLogs.js';
import type { SessionsRepo } from './sessions.js';
import { requireAuth, SESSION_COOKIE } from '../../plugins/guards.js';
import { capabilitiesOf } from '../users/roles.js';
import type { UsersRepo } from '../users/repo.js';

const MAX_UA_LEN = 300;

export interface AuthRouteDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
  loginLogs: LoginLogsRepo;
  audit: AuditRecorder;
  sessionTtlMs: number;
}

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });

  // 登录日志与审计写入失败不应阻断登录
  const recordLogin = (
    input: Parameters<LoginLogsRepo['record']>[0],
    req: { ip: string; headers: Record<string, unknown> },
  ): void => {
    try {
      const ua = req.headers['user-agent'];
      deps.loginLogs.record({
        ...input,
        ip: req.ip,
        userAgent: typeof ua === 'string' ? ua.slice(0, MAX_UA_LEN) : null,
      });
    } catch (err) {
      app.log.warn({ err }, '写入登录日志失败');
    }
    // 登录事件同时进入系统审计列表（username 显式传入：失败时用户可能不存在）
    deps.audit.record({
      userId: input.userId,
      username: input.username,
      action: input.success ? 'login' : 'login_failed',
      resource: 'auth',
      resourceName: input.username,
      description: input.success
        ? `登录成功（${req.ip}）`
        : `登录失败（${input.reason ?? '未知原因'}）（${req.ip}）`,
    });
  };

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: '缺少用户名或密码' });
    const user = deps.users.findByUsername(username);
    if (!user) {
      recordLogin({ userId: null, username, success: false, reason: '用户不存在' }, req);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (user.status !== 'active') {
      recordLogin({ userId: user.id, username, success: false, reason: '账号已禁用' }, req);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      recordLogin({ userId: user.id, username, success: false, reason: '密码错误' }, req);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const sess = deps.sessions.create(user.id, deps.sessionTtlMs);
    reply.setCookie(SESSION_COOKIE, sess.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(deps.sessionTtlMs / 1000),
    });
    recordLogin({ userId: user.id, username, success: true }, req);
    const roles = deps.users.rolesOf(user.id);
    return { id: user.id, username: user.username, roles, capabilities: [...capabilitiesOf(roles)] };
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
    roles: req.auth!.roles,
    capabilities: [...req.auth!.caps],
  }));
}
