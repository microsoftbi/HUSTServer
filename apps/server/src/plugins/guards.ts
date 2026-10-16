import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionsRepo } from '../modules/auth/sessions.js';
import type { UsersRepo } from '../modules/users/repo.js';
import { capabilitiesOf, CAP_LABELS, type Capability, type Role } from '../modules/users/roles.js';

export interface AuthContext {
  userId: string;
  username: string;
  roles: Role[];
  caps: Set<Capability>;
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
    const roles = deps.users.rolesOf(user.id);
    req.auth = { userId: user.id, username: user.username, roles, caps: capabilitiesOf(roles) };
  };
}

export function requireCap(cap: Capability) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth?.caps.has(cap)) {
      await reply.code(403).send({ error: `需要「${CAP_LABELS[cap]}」权限` });
    }
  };
}

export function requireAnyCap(...caps: Capability[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!caps.some((cap) => req.auth?.caps.has(cap))) {
      await reply
        .code(403)
        .send({ error: `需要「${caps.map((c) => CAP_LABELS[c]).join('」或「')}」权限` });
    }
  };
}

export const requireAdmin = requireCap('admin');
