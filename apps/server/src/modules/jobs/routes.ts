import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { AuditRecorder } from '../audit/repo.js';
import { connectionsRepo } from '../connections/repo.js';
import { isFreqType, nextRunAt, presetToCron, validateCron, CronFormatError, type FreqType } from '../schedules/cron.js';
import type { UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import { parseNodeConfig, type NodeConfigInput } from './config.js';
import { assertAcyclic } from './graph.js';
import {
  jobRunsRepo, jobStepRunsRepo, jobsRepo,
  type JobEdgeInput, type JobNodeInput, type JobNodeMode, type JobRow,
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

interface NodeBody extends NodeConfigInput {
  key?: unknown;
  type?: unknown;
  name?: unknown;
  onFailure?: unknown;
  mode?: unknown;
  x?: unknown;
  y?: unknown;
}

interface EdgeBody {
  source?: unknown;
  target?: unknown;
}

interface JobBody {
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
  edges?: unknown;
  /** 旧版请求：按数组顺序自动成链 */
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

interface ParsedBody {
  name: string;
  description: string | null;
  nodes: JobNodeInput[];
  edges: JobEdgeInput[];
  schedule: ParsedSchedule;
}

const NODE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NODES = 200;
const MAX_EDGES = 400;

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
  function parseBody(raw: JobBody, isAdmin: boolean, userId: string, reply: FastifyReply): ParsedBody | null {
    const name = asString(raw.name);
    if (!name) {
      reply.code(400).send({ error: 'name 不能为空' });
      return null;
    }

    const legacy = raw.nodes === undefined;
    let items: NodeBody[];
    if (!legacy) {
      if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
        reply.code(400).send({ error: '节点数量需在 1-200 之间' });
        return null;
      }
      items = raw.nodes as NodeBody[];
    } else if (Array.isArray(raw.steps) && raw.steps.length > 0) {
      items = raw.steps as NodeBody[];
    } else {
      reply.code(400).send({ error: '节点数量需在 1-200 之间' });
      return null;
    }
    if (items.length > MAX_NODES) {
      reply.code(400).send({ error: '节点数量需在 1-200 之间' });
      return null;
    }

    const nodes: JobNodeInput[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (typeof item !== 'object' || item === null) {
        reply.code(400).send({ error: '节点格式无效' });
        return null;
      }
      const type = item.type;
      if (type !== 'workflow' && type !== 'sql' && type !== 'load_model') {
        reply.code(400).send({ error: '步骤类型无效' });
        return null;
      }
      const parsed = parseNodeConfig(type, item, {
        resourceDir: deps.config.resourceDir,
        isAdmin,
        userId,
        connections,
        workflows,
      });
      if (!parsed.ok) {
        reply.code(400).send({ error: parsed.error });
        return null;
      }

      let key: string;
      if (typeof item.key === 'string' && item.key) {
        if (!NODE_KEY_RE.test(item.key) || keys.has(item.key)) {
          reply.code(400).send({ error: '节点标识不合法或重复' });
          return null;
        }
        key = item.key;
      } else if (legacy) {
        key = `n_${nanoid(10)}`;
        while (keys.has(key)) key = `n_${nanoid(10)}`;
      } else {
        reply.code(400).send({ error: '节点标识不合法或重复' });
        return null;
      }
      keys.add(key);

      let mode: JobNodeMode = 'run';
      if (item.mode !== undefined) {
        if (item.mode !== 'run' && item.mode !== 'skip' && item.mode !== 'disable') {
          reply.code(400).send({ error: '节点运行模式不合法' });
          return null;
        }
        mode = item.mode;
      }

      const x = item.x === undefined ? i * 260 : item.x;
      const y = item.y === undefined ? 0 : item.y;
      if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
        reply.code(400).send({ error: '节点坐标不合法' });
        return null;
      }

      nodes.push({
        key,
        type,
        name: asString(item.name) ?? '',
        config: parsed.config,
        onFailure: item.onFailure === 'continue' ? 'continue' : 'abort',
        mode,
        x,
        y,
      });
    }

    const edges: JobEdgeInput[] = [];
    if (legacy) {
      for (let i = 1; i < nodes.length; i += 1) {
        edges.push({ source: nodes[i - 1].key, target: nodes[i].key });
      }
    } else if (raw.edges !== undefined) {
      if (!Array.isArray(raw.edges)) {
        reply.code(400).send({ error: '连线格式无效' });
        return null;
      }
      if (raw.edges.length > MAX_EDGES) {
        reply.code(400).send({ error: '连线数量需在 0-400 之间' });
        return null;
      }
      const seen = new Set<string>();
      for (const rawEdge of raw.edges as EdgeBody[]) {
        if (typeof rawEdge !== 'object' || rawEdge === null) {
          reply.code(400).send({ error: '连线格式无效' });
          return null;
        }
        const source = asString(rawEdge.source);
        const target = asString(rawEdge.target);
        if (!source || !target) {
          reply.code(400).send({ error: '连线格式无效' });
          return null;
        }
        if (!keys.has(source) || !keys.has(target)) {
          reply.code(400).send({ error: '连线引用了不存在的节点' });
          return null;
        }
        if (source === target) {
          reply.code(400).send({ error: '不能连接到自身' });
          return null;
        }
        const pair = `${source}\u0000${target}`;
        if (seen.has(pair)) {
          reply.code(400).send({ error: '存在重复连线' });
          return null;
        }
        seen.add(pair);
        edges.push({ source, target });
      }
      try {
        assertAcyclic(nodes.map((n) => n.key), edges);
      } catch (err) {
        reply.code(400).send({ error: err instanceof Error ? err.message : '存在循环依赖' });
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
      return { name, description: asString(raw.description) ?? null, nodes, edges, schedule: { enabled: true, freqType, cronExpr, timezone } };
    }
    return {
      name, description: asString(raw.description) ?? null, nodes, edges,
      schedule: { enabled: false, freqType: null, cronExpr: null, timezone: defaultTimezone },
    };
  }

  function toDetail(job: JobRow) {
    return {
      ...job,
      nextRunAt: nextRun(job),
      nodes: jobs.listNodes(job.id).map((s) => ({
        key: s.node_key ?? s.id,
        seq: s.seq,
        type: s.type,
        name: s.name,
        onFailure: s.on_failure,
        mode: s.run_mode,
        x: s.pos_x,
        y: s.pos_y,
        config: JSON.parse(s.config) as unknown,
      })),
      edges: jobs.listEdges(job.id).map((e) => ({ source: e.source_key, target: e.target_key })),
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
        nodeCount: jobs.listNodes(job.id).length,
        edgeCount: jobs.listEdges(job.id).length,
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
      cronExpr: parsed.schedule.cronExpr, timezone: parsed.schedule.timezone,
      nodes: parsed.nodes, edges: parsed.edges,
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
    return buildJobFile(job, jobs.listNodes(job.id), jobs.listEdges(job.id), { connections, workflows });
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
      nodes: parsed.data.nodes,
      edges: parsed.data.edges,
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
      cronExpr: parsed.schedule.cronExpr, timezone: parsed.schedule.timezone,
      nodes: parsed.nodes, edges: parsed.edges,
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

  // 跨 Job 的运行记录：供「Job 日志」页展示全部运行（不只是每个 Job 的最近一次）。
  app.get('/api/job-runs', { preHandler: [guard, requireCap('job')] }, async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const ownerId = req.auth!.caps.has('admin') ? null : req.auth!.userId;
    return {
      total: jobRuns.countRecent(ownerId),
      items: jobRuns.listRecent({ ownerId, limit, offset }),
    };
  });

  app.get('/api/job-runs/:id', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobRun = jobRuns.findById(id);
    if (!jobRun) return reply.code(404).send({ error: 'Job 运行不存在' });
    const job = jobs.findById(jobRun.job_id);
    if (!job || !canAccess(job.owner_id, req.auth!.caps.has('admin'), req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    return {
      jobRun,
      graph: jobRun.graph_snapshot ? (JSON.parse(jobRun.graph_snapshot) as unknown) : null,
      steps: stepRuns.listByJobRun(id),
    };
  });

  app.post('/api/job-runs/:id/cancel', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobRun = jobRuns.findById(id);
    if (!jobRun) return reply.code(404).send({ error: 'Job 运行不存在' });
    const job = jobs.findById(jobRun.job_id);
    if (!job || !canAccess(job.owner_id, req.auth!.caps.has('admin'), req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    if (!deps.jobService.cancel(id)) {
      return reply.code(409).send({ error: '当前运行不可取消', code: 'JOB_RUN_NOT_CANCELABLE' });
    }
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'other',
      resource: 'job',
      resourceName: job.name,
      description: `取消了 Job「${job.name}」的运行`,
    });
    return { ok: true };
  });
}
