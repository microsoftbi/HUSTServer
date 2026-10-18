import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { isAuditAction, isAuditResource, type AuditRepo } from './repo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AuditRouteDeps {
  audit: AuditRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
}

export function auditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  /** 系统审计：按时间倒序返回操作记录，可按操作类型与资源类型筛选 */
  app.get('/api/admin/audit-logs', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { limit: rawLimit, offset: rawOffset, action, resource } = req.query as {
      limit?: string;
      offset?: string;
      action?: string;
      resource?: string;
    };

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return reply.code(400).send({ error: `limit 需为 1-${MAX_LIMIT} 的整数` });
      }
      limit = parsed;
    }

    let offset = 0;
    if (rawOffset !== undefined && rawOffset !== '') {
      const parsed = Number(rawOffset);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return reply.code(400).send({ error: 'offset 需为非负整数' });
      }
      offset = parsed;
    }

    if (action !== undefined && action !== '' && !isAuditAction(action)) {
      return reply.code(400).send({ error: 'action 非法' });
    }
    if (resource !== undefined && resource !== '' && !isAuditResource(resource)) {
      return reply.code(400).send({ error: 'resource 非法' });
    }

    const { items, total } = deps.audit.list({
      limit,
      offset,
      action: isAuditAction(action) ? action : undefined,
      resource: isAuditResource(resource) ? resource : undefined,
    });

    return {
      total,
      limit,
      offset,
      items: items.map((row) => ({
        id: row.id,
        username: row.username,
        action: row.action,
        resource: row.resource,
        resource_name: row.resource_name,
        description: row.description,
        created_at: row.created_at,
      })),
    };
  });
}
