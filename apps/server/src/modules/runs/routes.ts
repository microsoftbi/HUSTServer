import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { Role, UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import type { Recorder } from './recorder.js';
import { runLogsRepo, runNodeResultsRepo, runsRepo } from './repo.js';
import type { RunService } from './service.js';
import { endSse, eventName, openSse, writeEvent } from './sse.js';

export interface RunRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  recorder: Recorder;
  runService: RunService;
}

export function runRoutes(app: FastifyInstance, deps: RunRoutesDeps): void {
  const runs = runsRepo(deps.db);
  const nodes = runNodeResultsRepo(deps.db);
  const logs = runLogsRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });

  const canAccess = (ownerId: string, role: Role, userId: string): boolean =>
    role === 'admin' || ownerId === userId;

  /** 校验 run 归属，返回 run 及其工作流；不通过时已发送错误响应。 */
  function authorizeRun(runId: string, role: Role, userId: string): { run: ReturnType<typeof runs.findById>; ok: boolean } {
    const run = runs.findById(runId);
    if (!run) return { run: null, ok: false };
    const wf = workflows.findById(run.workflow_id);
    return { run, ok: !!wf && canAccess(wf.owner_id, role, userId) };
  }

  app.post('/api/workflows/:id/runs', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) return reply.code(404).send({ error: '工作流不存在' });
    if (!canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const run = deps.runService.trigger(id, { triggerType: 'manual', triggeredBy: req.auth!.userId });
    return reply.code(202).send({ runId: run.id });
  });

  app.get('/api/workflows/:id/runs', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) return reply.code(404).send({ error: '工作流不存在' });
    if (!canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    return {
      total: runs.countByWorkflow(id),
      items: runs.listByWorkflow(id, { limit, offset }),
    };
  });

  app.get('/api/runs/:runId', { preHandler: guard }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.role, req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    return { run: authorized.run, nodes: nodes.listByRun(runId) };
  });

  app.get('/api/runs/:runId/logs', { preHandler: guard }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.role, req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(Number(q.after) || 0, 0);
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
    return { items: logs.listByRun(runId, { after, limit }) };
  });

  app.get('/api/runs/:runId/events', { preHandler: guard }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.role, req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });

    openSse(reply);
    const off = deps.recorder.subscribe(
      runId,
      (event) => writeEvent(reply, eventName(event), event),
      () => {
        writeEvent(reply, 'done', { runId });
        endSse(reply);
      },
    );
    if (!off) {
      // 运行已结束：让前端回退到 /runs/:id 与 /logs
      writeEvent(reply, 'done', { runId, finished: true });
      endSse(reply);
      return reply;
    }
    req.raw.on('close', () => off());
    return reply;
  });
}
