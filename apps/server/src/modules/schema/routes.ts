import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  probeCsvSchema,
  probeExcelSchema,
  probeSqlServerSchema,
  type SqlServerConnection,
} from '@hustserver/engine';
import { requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';

export interface SchemaRouteDeps {
  resourceDir: string;
  /** 上传目录：相对路径的 CSV/Excel 引用按引擎语义落到此处。 */
  uploadDir: string;
  users: UsersRepo;
  sessions: SessionsRepo;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 输入节点结构探测：字段名与类型，供下游节点配置面板的列下拉使用。
 * 路径语义与引擎 resolveInputPath 一致，但仅允许资源库与上传目录内的文件。
 */
export function schemaRoutes(app: FastifyInstance, deps: SchemaRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const root = path.resolve(deps.resourceDir);
  const uploadRoot = path.resolve(deps.uploadDir);

  const assertPathAllowed = (raw: string): void => {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.join(uploadRoot, raw);
    const allowed = [root, uploadRoot].some(
      (base) => abs === base || abs.startsWith(base + path.sep),
    );
    if (!allowed) throw new Error('路径不在允许的目录内');
  };

  app.post('/api/schema/csv', { preHandler: auth }, async (req, reply) => {
    const cfg = (req.body ?? {}) as {
      path?: string;
      delimiter?: string;
      hasHeader?: boolean;
      encoding?: 'utf-8' | 'gbk';
    };
    if (!cfg.path) return reply.code(400).send({ error: '缺少文件路径' });
    try {
      assertPathAllowed(cfg.path);
      return { columns: await probeCsvSchema(cfg) };
    } catch (err) {
      return reply.code(400).send({ error: '解析 CSV 失败', detail: errMessage(err) });
    }
  });

  app.post('/api/schema/excel', { preHandler: auth }, async (req, reply) => {
    const cfg = (req.body ?? {}) as { path?: string; sheet?: string; hasHeader?: boolean };
    if (!cfg.path) return reply.code(400).send({ error: '缺少文件路径' });
    try {
      assertPathAllowed(cfg.path);
      return { columns: probeExcelSchema(cfg) };
    } catch (err) {
      return reply.code(400).send({ error: '解析 Excel 失败', detail: errMessage(err) });
    }
  });

  app.post('/api/schema/sqlserver', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { connection?: SqlServerConnection; query?: string };
    const conn = body.connection;
    if (!conn?.server || !conn.database || !conn.user) {
      return reply.code(400).send({ error: '连接信息不完整' });
    }
    if (!body.query?.trim()) return reply.code(400).send({ error: '缺少查询语句' });
    try {
      return { columns: await probeSqlServerSchema({ connection: conn, query: body.query }) };
    } catch (err) {
      return reply.code(400).send({ error: '探测列失败', detail: errMessage(err) });
    }
  });
}
