import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { ModelStore } from '../models/service.js';
import type { UsersRepo } from '../users/repo.js';
import { isAuditAction, isAuditResource, type AuditRepo } from './repo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 审计日志同步为数据模型时固定使用的模型名（重复加载整体覆盖） */
const AUDIT_MODEL_NAME = 'audit_logs';

/** 加载到模型时输出的列（顺序即建表顺序） */
const AUDIT_MODEL_COLUMNS = [
  'id',
  'username',
  'action',
  'resource',
  'resource_name',
  'description',
  'created_at',
];

export interface AuditRouteDeps {
  audit: AuditRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
  models: ModelStore;
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

  /** 系统审计 → 数据模型：把全部审计日志整体加载为模型 audit_logs（重复执行即刷新） */
  app.post(
    '/api/admin/audit-logs/load-model',
    { preHandler: [auth, requireAdmin] },
    async (req, reply) => {
      const rows = deps.audit.listAll().map((row) => ({
        id: row.id,
        username: row.username,
        action: row.action,
        resource: row.resource,
        resource_name: row.resource_name,
        description: row.description,
        // ISO 时间字符串由 DuckDB 自动推断为 TIMESTAMP，便于在仪表板中按时间分析
        created_at: new Date(row.created_at).toISOString(),
      }));

      try {
        const result = await deps.models.loadRows(
          {
            modelName: AUDIT_MODEL_NAME,
            rows,
            columns: AUDIT_MODEL_COLUMNS,
            sourceKind: 'audit',
            sourceRef: { kind: 'audit_logs' },
          },
          null,
        );
        deps.audit.record({
          userId: req.auth!.userId,
          action: 'create',
          resource: 'model',
          resourceName: AUDIT_MODEL_NAME,
          description: `将审计日志加载到数据模型「${AUDIT_MODEL_NAME}」（${result.rowCount} 条）`,
        });
        return { name: AUDIT_MODEL_NAME, rowCount: result.rowCount };
      } catch (err) {
        return reply.code(400).send({
          error: '加载到模型失败',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
