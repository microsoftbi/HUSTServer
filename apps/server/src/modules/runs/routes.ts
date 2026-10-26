import {
  ancestorNodeIds,
  getPinnedCache,
  NodeNotReadyError,
  NodeOutputMissingError,
  readNodePreview,
  RunExpiredError,
  unpinCache,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import type { AuditRecorder } from '../audit/repo.js';
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
  audit: AuditRecorder;
}

export function runRoutes(app: FastifyInstance, deps: RunRoutesDeps): void {
  const runs = runsRepo(deps.db);
  const nodes = runNodeResultsRepo(deps.db);
  const logs = runLogsRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });

  const canAccess = (ownerId: string, isAdmin: boolean, userId: string): boolean =>
    isAdmin || ownerId === userId;

  /** 校验 run 归属，返回 run 及其工作流；不通过时已发送错误响应。 */
  function authorizeRun(runId: string, isAdmin: boolean, userId: string): { run: ReturnType<typeof runs.findById>; ok: boolean } {
    const run = runs.findById(runId);
    if (!run) return { run: null, ok: false };
    const wf = workflows.findById(run.workflow_id);
    return { run, ok: !!wf && canAccess(wf.owner_id, isAdmin, userId) };
  }

  app.post('/api/workflows/:id/runs', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) return reply.code(404).send({ error: '工作流不存在' });
    if (!canAccess(wf.owner_id, req.auth!.caps.has('admin'), req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }

    const body = (req.body ?? {}) as {
      targetNodeId?: string;
      /** 「缓存至此」：本次运行成功后冻结该节点及其上游。 */
      freeze?: boolean;
      /** 复用已有缓存：从缓存节点之后继续运行。 */
      cacheToken?: string;
    };
    const targetNodeId = body.targetNodeId?.trim() || undefined;

    let workflow: Workflow | null = null;
    if (targetNodeId || body.freeze) {
      const payload = JSON.parse(wf.payload) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
      workflow = {
        id: wf.id,
        name: wf.name,
        nodes: payload.nodes ?? [],
        edges: payload.edges ?? [],
        createdAt: wf.created_at,
        updatedAt: wf.updated_at,
      };
      if (targetNodeId && !workflow.nodes.some((node) => node.id === targetNodeId)) {
        return reply.code(400).send({ error: `目标节点不存在：${targetNodeId}` });
      }
    }

    // 「缓存至此」：为边界节点分配缓存令牌，成功后钉住其会话。
    if (body.freeze) {
      if (!targetNodeId || !workflow) {
        return reply.code(400).send({ error: '缓存至此需要指定目标节点' });
      }
      const cacheToken = nanoid(12);
      const run = deps.runService.trigger(id, {
        triggerType: 'manual',
        triggeredBy: req.auth!.userId,
        targetNodeId,
        freezeToken: cacheToken,
      });
      // 边界节点及其全部上游：前端据此标记「已缓存」。
      const cachedNodeIds = [...ancestorNodeIds(workflow, targetNodeId), targetNodeId];
      deps.audit.record({
        userId: req.auth!.userId,
        action: 'other',
        resource: 'workflow',
        resourceName: wf.name,
        description: `运行了工作流「${wf.name}」`,
      });
      return reply.code(202).send({ runId: run.id, cacheToken, cachedNodeIds });
    }

    // 复用已有缓存：令牌已失效则回 400，前端据此回退为全量重跑。
    const cacheToken = body.cacheToken?.trim() || undefined;
    if (cacheToken && !getPinnedCache(cacheToken)) {
      return reply.code(400).send({ error: '缓存已失效', code: 'CACHE_EXPIRED' });
    }

    const run = deps.runService.trigger(id, {
      triggerType: 'manual',
      triggeredBy: req.auth!.userId,
      ...(targetNodeId ? { targetNodeId } : {}),
      ...(cacheToken ? { cacheToken } : {}),
    });
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'other',
      resource: 'workflow',
      resourceName: wf.name,
      description: `运行了工作流「${wf.name}」`,
    });
    return reply.code(202).send({ runId: run.id });
  });

  // 取消缓存：关闭被钉住的会话并清理缓存状态。
  app.delete('/api/runs/cache/:cacheToken', { preHandler: [guard, requireCap('job')] }, async (req) => {
    const { cacheToken } = req.params as { cacheToken: string };
    return { ok: unpinCache(cacheToken) };
  });

  app.get('/api/workflows/:id/runs', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) return reply.code(404).send({ error: '工作流不存在' });
    if (!canAccess(wf.owner_id, req.auth!.caps.has('admin'), req.auth!.userId)) {
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

  // 取消运行：引擎在当前节点结束后停止，剩余节点标记为跳过。
  app.post('/api/runs/:runId/cancel', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.caps.has('admin'), req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    if (!deps.runService.cancel(runId)) {
      return reply.code(409).send({ error: '当前运行不可取消', code: 'RUN_NOT_CANCELABLE' });
    }
    return { ok: true };
  });

  app.get('/api/runs/:runId', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.caps.has('admin'), req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    return { run: authorized.run, nodes: nodes.listByRun(runId) };
  });
  app.get('/api/runs/:runId/logs', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.caps.has('admin'), req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(Number(q.after) || 0, 0);
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
    return { items: logs.listByRun(runId, { after, limit }) };
  });

  app.get('/api/runs/:runId/preview', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.caps.has('admin'), req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });

    const q = req.query as { nodeId?: string; limit?: string; handle?: string };
    const nodeId = q.nodeId?.trim();
    if (!nodeId) return reply.code(400).send({ error: '缺少 nodeId 参数' });

    const engineRunId = authorized.run.engine_run_id;
    if (!engineRunId) {
      return reply.code(409).send({ error: '运行尚未开始', detail: '该运行还没有可用的引擎会话' });
    }

    const limit = q.limit === undefined ? undefined : Number(q.limit);
    try {
      const preview = await readNodePreview(engineRunId, nodeId, {
        handle: q.handle ?? null,
        ...(limit === undefined ? {} : { limit }),
      });
      return preview;
    } catch (error) {
      if (error instanceof RunExpiredError) {
        return reply.code(410).send({ error: error.message, code: error.code });
      }
      if (error instanceof NodeNotReadyError) {
        return reply.code(409).send({ error: error.message, detail: error.detail, code: error.code });
      }
      if (error instanceof NodeOutputMissingError) {
        return reply.code(404).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get('/api/runs/:runId/events', { preHandler: [guard, requireCap('job')] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.caps.has('admin'), req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });

    openSse(reply);

    let closed = false;
    let off: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      writeEvent(reply, 'done', { runId });
      endSse(reply);
    };

    // 运行可能仍在排队（引擎会话尚未挂载，recorder 里还没有条目）。此时若立刻收尾，
    // 前端会读到 queued 快照并卡在「运行中」；故轮询等待会话挂载或运行进入终态。
    const subscribe = (): void => {
      if (closed) return;
      off = deps.recorder.subscribe(
        runId,
        (event) => writeEvent(reply, eventName(event), event),
        finish,
      );
      if (off) return;
      const run = runs.findById(runId);
      if (!run || run.status === 'success' || run.status === 'error' || run.status === 'canceled') {
        finish();
        return;
      }
      retryTimer = setTimeout(subscribe, 200);
    };

    subscribe();
    req.raw.on('close', () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      off?.();
    });
    return reply;
  });
}
