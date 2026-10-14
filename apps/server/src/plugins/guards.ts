import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionsRepo } from '../modules/auth/sessions.js';
import type { Role, UsersRepo } from '../modules/users/repo.js';

export interface AuthContext {
  userId: string;
  role: Role;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const SESSION_COOKIE = 'hs_session';

export function requireAuth(deps: { users: UsersRepo; sessions: SessionsRepo }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) {
      await reply.code(401).send({ error: '未登录' });
      return;
    }
    const sess = deps.sessions.findValid(token);
    if (!sess) {
      await reply.code(401).send({ error: '会话无效或已过期' });
      return;
    }
    const user = deps.users.findById(sess.user_id);
    if (!user || user.status !== 'active') {
      await reply.code(401).send({ error: '账号不可用' });
      return;
    }
    req.auth = { userId: user.id, role: user.role, username: user.username };
  };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.auth?.role !== 'admin') {
    await reply.code(403).send({ error: '需要管理员权限' });
  }
}
