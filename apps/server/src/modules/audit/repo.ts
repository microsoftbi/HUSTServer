import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

/** 操作类型 */
export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'other', 'login', 'login_failed'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 资源类型 */
export const AUDIT_RESOURCES = [
  'workflow',
  'dashboard',
  'model',
  'resource',
  'connection',
  'job',
  'user',
  'auth',
] as const;
export type AuditResource = (typeof AUDIT_RESOURCES)[number];

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  username: string;
  action: AuditAction;
  resource: AuditResource;
  resource_name: string | null;
  description: string;
  created_at: number;
}

export interface AuditInput {
  userId: string | null;
  action: AuditAction;
  resource: AuditResource;
  resourceName?: string | null;
  description: string;
  /** 显式指定操作者名称（如登录失败时用户不存在，需展示表单输入的用户名） */
  username?: string;
}

export interface AuditQuery {
  limit: number;
  offset: number;
  action?: AuditAction;
  resource?: AuditResource;
}

/** 供各业务路由依赖的最小接口 */
export interface AuditRecorder {
  record(input: AuditInput): void;
}

export interface AuditRepo extends AuditRecorder {
  list(query: AuditQuery): { items: AuditLogRow[]; total: number };
}

export function isAuditAction(v: unknown): v is AuditAction {
  return typeof v === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(v);
}

export function isAuditResource(v: unknown): v is AuditResource {
  return typeof v === 'string' && (AUDIT_RESOURCES as readonly string[]).includes(v);
}

export interface AuditRepoOptions {
  /** 审计写入失败时的回调（审计为旁路功能，不应阻断主流程） */
  onError?: (err: unknown) => void;
}

export function auditRepo(db: Database, options: AuditRepoOptions = {}): AuditRepo {
  const insert = db.prepare(
    `INSERT INTO audit_logs (id, user_id, username, action, resource, resource_name, description, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  // 用户名冗余存储：用户被删除后审计记录仍可读
  const findUser = db.prepare('SELECT username FROM users WHERE id = ?');

  return {
    record({ userId, action, resource, resourceName = null, description, username: explicitName }) {
      // 查不到的用户（已删除或不存在的 id）不写 user_id，避免违反外键约束
      const found = userId
        ? (findUser.get(userId) as { username: string } | undefined)
        : undefined;
      try {
        insert.run(
          nanoid(12),
          found ? userId : null,
          explicitName ?? found?.username ?? '未知用户',
          action,
          resource,
          resourceName,
          description,
          Date.now(),
        );
      } catch (err) {
        options.onError?.(err);
      }
    },

    list({ limit, offset, action, resource }) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (action) {
        where.push('action = ?');
        params.push(action);
      }
      if (resource) {
        where.push('resource = ?');
        params.push(resource);
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      const { c } = db
        .prepare(`SELECT COUNT(*) AS c FROM audit_logs${whereSql}`)
        .get(...params) as { c: number };
      const items = db
        .prepare(
          `SELECT * FROM audit_logs${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as AuditLogRow[];
      return { items, total: c };
    },
  };
}
