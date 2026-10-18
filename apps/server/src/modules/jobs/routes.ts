import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { AuditRecorder } from '../audit/repo.js';
import { connectionsRepo } from '../connections/repo.js';
import { MODEL_NAME_RE, type LoadModelConfig } from '../models/service.js';
import { isAllowedResourceFile, resolveResourcePath } from '../resources/paths.js';
import { CronFormatError, isFreqType, nextRunAt, presetToCron, validateCron, type FreqType } from '../schedules/cron.js';
import type { UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import {
  jobRunsRepo, jobStepRunsRepo, jobsRepo,
  type JobOnFailure, type JobRow, type JobStepInput,
} from './repo.js';
import type { JobService } from './service.js';
import { buildJobFile, parseJobFile } from './transfer.js';

export interface JobRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  jobService: JobService;
  resync: () => void;
  audit: AuditRecorder;
}

interface StepBody {
  type?: unknown;
  name?: unknown;
  onFailure?: unknown;
  workflowId?: unknown;
  connectionId?: unknown;
  sql?: unknown;
  modelName?: unknown;
  source?: unknown;
  resourcePath?: unknown;
  format?: unknown;
  delimiter?: unknown;
  hasHeader?: unknown;
  encoding?: unknown;
  sheet?: unknown;
  object?: unknown;
  query?: unknown;
}

interface JobBody {
  name?: unknown;
  description?: unknown;
  steps?: unknown;
  schedule?: {
    enabled?: unknown;
    freqType?: unknown;
    time?: unknown;
    weekday?: unknown;
    monthDay?: unknown;
    cronExpr?: unknown;
    timezone?: unknown;
  };
}

interface ParsedSchedule {
  enabled: boolean;
  freqType: FreqType | null;
  cronExpr: string | null;
  timezone: string;
}

export function jobRoutes(app: FastifyInstance, deps: JobRoutesDeps): void {
  const jobs = jobsRepo(deps.db);
  const jobRuns = jobRunsRepo(deps.db);
  const stepRuns = jobStepRunsRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const connections = connectionsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });
  const defaultTimezone = deps.config.tz;

  const canAccess = (ownerId: string, isAdmin: boolean, userId: string): boolean =>
    isAdmin || ownerId === userId;
  const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const nextRun = (job: JobRow): number | null =>
    job.enabled && job.cron_expr ? nextRunAt(job.cron_expr, job.timezone) : null;

  /** 按归属校验 Job；不通过时已发送响应并返回 null。 */
  function loadJob(id: string, isAdmin: boolean, userId: string, reply: FastifyReply): JobRow | null {
    const job = jobs.findById(id);
    if (!job) {
      reply.code(404).send({ error: 'Job 不存在' });
      return null;
    }
    if (!canAccess(job.owner_id, isAdmin, userId)) {
      reply.code(403).send({ error: '无权访问' });
      return null;
    }
    return job;
  }

  /** 解析并校验请求体；失败时已发送响应并返回 null。 */
  function parseBody(
    raw: JobBody,
    isAdmin: boolean,
    userId: string,
    reply: FastifyReply,
  ): { name: string; description: string | null; steps: JobStepInput[]; schedule: ParsedSchedule } | null {
    const name = asString(raw.name);
    if (!name) {
      reply.code(400).send({ error: 'name 不能为空' });
      return null;
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      reply.code(400).send({ error: 'steps 至少需要一条' });
      return null;
    }
    const steps: JobStepInput[] = [];
    for (const item of raw.steps as StepBody[]) {
      const stepName = asString(item.name) ?? '';
      const onFailure: JobOnFailure = item.onFailure === 'continue' ? 'continue' : 'abort';
      if (item.type === 'workflow') {
        const workflowId = asString(item.workflowId);
        const wf = workflowId ? workflows.findById(workflowId) : null;
        if (!wf || !canAccess(wf.owner_id, isAdmin, userId)) {
          reply.code(400).send({ error: '工作流不可用' });
          return null;
        }
        steps.push({ type: 'workflow', name: stepName, config: JSON.stringify({ workflowId }), onFailure });
      } else if (item.type === 'sql') {
        const connectionId = asString(item.connectionId);
        const sqlText = asString(item.sql);
        const conn = connectionId ? connections.findById(connectionId) : null;
        if (!conn || !(isAdmin || conn.shared === 1 || conn.owner_id === userId)) {
          reply.code(400).send({ error: '连接不可用' });
          return null;
        }
        if (!sqlText) {
          reply.code(400).send({ error: 'SQL 不能为空' });
          return null;
        }
        steps.push({ type: 'sql', name: stepName, config: JSON.stringify({ connectionId, sql: sqlText }), onFailure });
      } else if (item.type === 'load_model') {
        const modelName = asString(item.modelName);
        if (!modelName || !MODEL_NAME_RE.test(modelName)) {
          reply.code(400).send({ error: '模型名不合法' });
          return null;
        }
        if (item.source === 'file') {
          const resourcePath = asString(item.resourcePath);
          if (!resourcePath) {
            reply.code(400).send({ error: '资源文件不可用' });
            return null;
          }
          let abs: string;
          try {
            abs = resolveResourcePath(deps.config.resourceDir, resourcePath);
          } catch {
            reply.code(400).send({ error: '资源文件不可用' });
            return null;
          }
          if (!isAllowedResourceFile(abs) || !fs.existsSync(abs)) {
            reply.code(400).send({ error: '资源文件不可用' });
            return null;
          }
          const format =
            item.format === 'csv' || item.format === 'excel' ? item.format : undefined;
          steps.push({
            type: 'load_model',
            name: stepName,
            config: JSON.stringify({
              source: 'file',
              modelName,
              resourcePath,
              ...(format ? { format } : {}),
            } satisfies LoadModelConfig),
            onFailure,
          });
        } else if (item.source === 'sqlserver') {
          const connectionId = asString(item.connectionId);
          const conn = connectionId ? connections.findById(connectionId) : null;
          if (!connectionId || !conn || !(isAdmin || conn.shared === 1 || conn.owner_id === userId)) {
            reply.code(400).send({ error: '连接不可用' });
            return null;
          }
          const object = asString(item.object);
          const query = asString(item.query);
          if (!object && !query) {
            reply.code(400).send({ error: '需要指定表或查询' });
            return null;
          }
          steps.push({
            type: 'load_model',
            name: stepName,
            config: JSON.stringify({
              source: 'sqlserver',
              modelName,
              connectionId,
              ...(object ? { object } : {}),
              ...(query ? { query } : {}),
            } satisfies LoadModelConfig),
            onFailure,
          });
        } else {
          reply.code(400).send({ error: '步骤来源无效' });
          return null;
        }
      } else {
        reply.code(400).send({ error: '步骤类型无效' });
        return null;
      }
    }
    const sch = raw.schedule ?? { enabled: false };
    if (sch.enabled === true) {
      const freqType = isFreqType(sch.freqType) ? sch.freqType : null;
      if (!freqType) {
        reply.code(400).send({ error: 'freqType 无效' });
        return null;
      }
      const timezone = asString(sch.timezone) ?? defaultTimezone;
      let cronExpr: string;
      try {
        cronExpr = presetToCron({
          freqType,
          time: asString(sch.time),
          weekday: asNumber(sch.weekday),
          monthDay: asNumber(sch.monthDay),
          cronExpr: asString(sch.cronExpr),
        });
      } catch (err) {
        if (err instanceof CronFormatError) {
          reply.code(400).send({ error: err.message });
          return null;
        }
        throw err;
      }
      if (!validateCron(cronExpr, timezone)) {
        reply.code(400).send({ error: 'cron 表达式或时区无效' });
        return null;
      }
      return { name, description: asString(raw.description) ?? null, steps, schedule: { enabled: true, freqType, cronExpr, timezone } };
    }
    return {
      name, description: asString(raw.description) ?? null, steps,
      schedule: { enabled: false, freqType: null, cronExpr: null, timezone: defaultTimezone },
    };
  }

  function toDetail(job: JobRow) {
    return {
      ...job,
      nextRunAt: nextRun(job),
      steps: jobs.listSteps(job.id).map((s) => ({
        ...s, onFailure: s.on_failure, config: JSON.parse(s.config) as unknown,
      })),
      schedule: {
        enabled: job.enabled === 1,
        freqType: job.freq_type,
        cronExpr: job.cron_expr,
        timezone: job.timezone,
      },
    };
  }

  app.get('/api/jobs', { preHandler: [guard, requireCap('job')] }, async (req) => {
    const { userId } = req.auth!;
    const rows = req.auth!.caps.has('admin') ? jobs.listAll() : jobs.listForOwner(userId);
    const items = rows.map((job) => {
      const lastRun = jobRuns.listByJob(job.id, { limit: 1, offset: 0 })[0] ?? null;
      return {
        ...job,
        stepCount: jobs.listSteps(job.id).length,
        nextRunAt: nextRun(job),
        lastRun: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              created_at: lastRun.created_at,
              trigger_type: lastRun.trigger_type,
              duration_ms: lastRun.duration_ms,
            }
          : null,
      };
    });
    return { items };
  });

  app.post('/api/jobs', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const parsed = parseBody((req.body ?? {}) as JobBody, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!parsed) return reply;
    const job = jobs.create({
      ownerId: req.auth!.userId, name: parsed.name, description: parsed.description,
      enabled: parsed.schedule.enabled, freqType: parsed.schedule.freqType,
      cronExpr: parsed.schedule.cronExpr, timezone: parsed.schedule.timezone, steps: parsed.steps,
    });
    deps.resync();
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'create',
      resource: 'job',
      resourceName: job.name,
      description: `创建了 Job「${job.name}」`,
    });
    return reply.code(201).send(toDetail(job));
  });

  /** 导出 Job 配置为 JSON 内容（前端另存为文件） */
  app.get('/api/jobs/:id/export', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!job) return reply;
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'other',
      resource: 'job',
      resourceName: job.name,
      description: `导出了 Job「${job.name}」的配置`,
    });
    return buildJobFile(job, jobs.listSteps(job.id), { connections, workflows });
  });

  /** 从导出的 JSON 内容导入 Job：同名自动加后缀，连接/工作流按名称重新匹配 */
  app.post('/api/jobs/import', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const isAdmin = req.auth!.caps.has('admin');
    const userId = req.auth!.userId;
    const existing = isAdmin ? jobs.listAll() : jobs.listForOwner(userId);
    const parsed = parseJobFile(req.body, {
      connections,
      workflows,
      isAdmin,
      userId,
      takenNames: new Set(existing.map((j) => j.name)),
      defaultTimezone,
    });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const job = jobs.create({
      ownerId: userId,
      name: parsed.data.name,
      description: parsed.data.description,
      enabled: parsed.data.enabled,
      freqType: parsed.data.freqType,
      cronExpr: parsed.data.cronExpr,
      timezone: parsed.data.timezone,
      steps: parsed.data.steps,
    });
    deps.resync();
    deps.audit.record({
      userId,
      action: 'create',
      resource: 'job',
      resourceName: job.name,
      description: `导入了 Job「${job.name}」`,
    });
    return reply.code(201).send({ id: job.id, name: job.name, warnings: parsed.data.warnings });
  });

  app.get('/api/jobs/:id', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!job) return reply;
    return toDetail(job);
  });

  app.put('/api/jobs/:id', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!job) return reply;
    const parsed = parseBody((req.body ?? {}) as JobBody, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!parsed) return reply;
    const updated = jobs.update(id, {
      name: parsed.name, description: parsed.description,
      enabled: parsed.schedule.enabled, freqType: parsed.schedule.freqType,
      cronExpr: parsed.schedule.cronExpr, timezone: parsed.schedule.timezone, steps: parsed.steps,
    })!;
    deps.resync();
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'update',
      resource: 'job',
      resourceName: updated.name,
      description: `修改了 Job「${updated.name}」`,
    });
    return toDetail(updated);
  });

  app.delete('/api/jobs/:id', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!job) return reply;
    jobs.remove(id);
    deps.resync();
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'delete',
      resource: 'job',
      resourceName: job.name,
      description: `删除了 Job「${job.name}」`,
    });
    return { ok: true };
  });

  app.post('/api/jobs/:id/runs', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!job) return reply;
    try {
      const jobRun = deps.jobService.trigger(id, { triggerType: 'manual', triggeredBy: req.auth!.userId });
      deps.audit.record({
        userId: req.auth!.userId,
        action: 'other',
        resource: 'job',
        resourceName: job.name,
        description: `手动运行了 Job「${job.name}」`,
      });
      return reply.code(202).send({ jobRunId: jobRun.id });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : '触发失败' });
    }
  });

  app.get('/api/jobs/:id/runs', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.caps.has('admin'), req.auth!.userId, reply);
    if (!job) return reply;
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    return { total: jobRuns.countByJob(id), items: jobRuns.listByJob(id, { limit, offset }) };
  });

  app.get('/api/job-runs/:id', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobRun = jobRuns.findById(id);
    if (!jobRun) return reply.code(404).send({ error: 'Job 运行不存在' });
    const job = jobs.findById(jobRun.job_id);
    if (!job || !canAccess(job.owner_id, req.auth!.caps.has('admin'), req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    return { jobRun, steps: stepRuns.listByJobRun(id) };
  });
}
