import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { Role, UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import { CronFormatError, isFreqType, nextRunAt, presetToCron, validateCron } from './cron.js';
import { schedulesRepo } from './repo.js';

export interface ScheduleRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  resync: () => void;
}

interface ScheduleBody {
  freqType?: unknown;
  time?: unknown;
  weekday?: unknown;
  monthDay?: unknown;
  cronExpr?: unknown;
  timezone?: unknown;
  enabled?: unknown;
}

export function scheduleRoutes(app: FastifyInstance, deps: ScheduleRoutesDeps): void {
  const schedules = schedulesRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });
  const defaultTimezone = deps.config.tz;

  const canAccess = (ownerId: string, role: Role, userId: string): boolean =>
    role === 'admin' || ownerId === userId;

  const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const runAt = (cronExpr: string, timezone: string): number | null => nextRunAt(cronExpr, timezone);

  /** 按工作流校验归属；不通过时已发送响应并返回 false。 */
  function loadWorkflow(workflowId: string, role: Role, userId: string, reply: FastifyReply): boolean {
    const wf = workflows.findById(workflowId);
    if (!wf) {
      reply.code(404).send({ error: '工作流不存在' });
      return false;
    }
    if (!canAccess(wf.owner_id, role, userId)) {
      reply.code(403).send({ error: '无权访问' });
      return false;
    }
    return true;
  }

  app.get('/api/workflows/:id/schedules', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loadWorkflow(id, req.auth!.role, req.auth!.userId, reply)) return reply;
    const items = schedules.listByWorkflow(id).map((row) => ({
      ...row,
      nextRunAt: row.enabled ? runAt(row.cron_expr, row.timezone) : null,
    }));
    return { items };
  });

  app.post('/api/workflows/:id/schedules', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loadWorkflow(id, req.auth!.role, req.auth!.userId, reply)) return reply;

    const body = (req.body ?? {}) as ScheduleBody;
    const freqType = isFreqType(body.freqType) ? body.freqType : null;
    if (!freqType) return reply.code(400).send({ error: 'freqType 无效' });
    const timezone = asString(body.timezone) ?? defaultTimezone;

    let cronExpr: string;
    try {
      cronExpr = presetToCron({
        freqType,
        time: asString(body.time),
        weekday: asNumber(body.weekday),
        monthDay: asNumber(body.monthDay),
        cronExpr: asString(body.cronExpr),
      });
    } catch (err) {
      if (err instanceof CronFormatError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    if (!validateCron(cronExpr, timezone)) {
      return reply.code(400).send({ error: 'cron 表达式或时区无效' });
    }

    const row = schedules.create({
      workflowId: id,
      freqType,
      cronExpr,
      timezone,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    });
    deps.resync();
    return reply.code(201).send({ ...row, nextRunAt: row.enabled ? runAt(row.cron_expr, row.timezone) : null });
  });

  app.put('/api/schedules/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = schedules.findById(id);
    if (!cur) return reply.code(404).send({ error: '调度不存在' });
    const wf = workflows.findById(cur.workflow_id);
    if (!wf || !canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }

    const body = (req.body ?? {}) as ScheduleBody;
    const hasFreqField =
      body.freqType !== undefined ||
      body.time !== undefined ||
      body.weekday !== undefined ||
      body.monthDay !== undefined ||
      body.cronExpr !== undefined;

    const timezone = asString(body.timezone) ?? cur.timezone;
    const freqType = isFreqType(body.freqType) ? body.freqType : cur.freq_type;
    let cronExpr = cur.cron_expr;
    if (hasFreqField) {
      try {
        cronExpr = presetToCron({
          freqType,
          time: asString(body.time),
          weekday: asNumber(body.weekday),
          monthDay: asNumber(body.monthDay),
          cronExpr: asString(body.cronExpr) ?? cur.cron_expr,
        });
      } catch (err) {
        if (err instanceof CronFormatError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }
    if (!validateCron(cronExpr, timezone)) {
      return reply.code(400).send({ error: 'cron 表达式或时区无效' });
    }

    const updated = schedules.update(id, {
      freqType: hasFreqField ? freqType : undefined,
      cronExpr: hasFreqField ? cronExpr : undefined,
      timezone: body.timezone !== undefined ? timezone : undefined,
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    })!;
    deps.resync();
    return { ...updated, nextRunAt: updated.enabled ? runAt(updated.cron_expr, updated.timezone) : null };
  });

  app.delete('/api/schedules/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = schedules.findById(id);
    if (!cur) return reply.code(404).send({ error: '调度不存在' });
    const wf = workflows.findById(cur.workflow_id);
    if (!wf || !canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    schedules.remove(id);
    deps.resync();
    return { ok: true };
  });
}
