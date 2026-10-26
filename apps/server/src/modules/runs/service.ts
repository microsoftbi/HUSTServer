import {
  cancelRun as cancelEngineRun,
  createRun,
  executeWorkflow,
  type ModelWriteHook,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import { join, resolve, sep } from 'node:path';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { buildRuntimeWorkflow, type MapperDeps, type ResolvedConnection } from '../workflows/mapper.js';
import { pathMappingsRepo, workflowConnectionsRepo, workflowFilesRepo, workflowsRepo, type PathMappingRow, type WorkflowRow } from '../workflows/repo.js';
import { createSemaphore } from './queue.js';
import type { Recorder } from './recorder.js';
import { runsRepo, type RunRow, type RunStatus, type TriggerType } from './repo.js';

export interface RunExecutorInput {
  runId: string;
  workflow: Workflow;
  /** 「运行至此」目标节点；为空表示全量运行。 */
  targetNodeId?: string;
  /** 「缓存至此」：本次运行成功后钉住会话。 */
  freezeToken?: string;
  /** 复用已有缓存：跳过缓存节点、共享其会话。 */
  reuseToken?: string;
  onEngineRunId(engineRunId: string): void;
}

export type RunExecutor = (input: RunExecutorInput) => Promise<void>;

export interface RunServiceDeps {
  db: Database;
  config: AppConfig;
  recorder: Recorder;
  executor?: RunExecutor;
  /** 供 Data Model 输出节点写出模型（由模型库注入）。 */
  writeModel?: ModelWriteHook;
  concurrency?: number;
}

export interface RunService {
  trigger(
    workflowId: string,
    opts?: {
      triggerType?: TriggerType;
      scheduleId?: string | null;
      triggeredBy?: string | null;
      /** 触发本次运行的 job run（若有）。 */
      jobRunId?: string | null;
      /** 「运行至此」目标节点。 */
      targetNodeId?: string;
      /** 「缓存至此」：成功后钉住会话的冻结令牌。 */
      freezeToken?: string;
      /** 复用已有缓存。 */
      cacheToken?: string;
    },
  ): RunRow;
  /** 请求取消一次运行；引擎会在当前节点结束后停止。返回是否成功投递。 */
  cancel(runId: string): boolean;
  awaitRun(runId: string): Promise<RunStatus>;
  whenIdle(): Promise<void>;
}

/** 运行被用户取消：worker 据此落 canceled 终态且不重试。 */
export class RunCanceledError extends Error {
  readonly code = 'RUN_CANCELED';
  constructor(message = '运行已取消') {
    super(message);
    this.name = 'RunCanceledError';
  }
}

/** 默认执行器：走 vendored 引擎（createRun + executeWorkflow）。 */
function makeDefaultExecutor(writeModel?: ModelWriteHook): RunExecutor {
  return async ({ workflow, onEngineRunId, targetNodeId, freezeToken, reuseToken }) => {
    const ctx = await createRun(
      workflow,
      targetNodeId,
      {
        ...(freezeToken ? { freezeToken } : reuseToken ? { reuseToken } : {}),
        ...(writeModel ? { writeModel } : {}),
      },
    );
    onEngineRunId(ctx.runId);
    await executeWorkflow(ctx.runId);
    // 引擎在节点失败时只置状态、不抛异常；若不在此显式抛出，
    // worker 会把真实失败误记为 success 并跳过重试。
    if (ctx.status === 'error') {
      const failed = [...ctx.nodeResults.values()].find((result) => result.status === 'error');
      throw new Error(failed?.error ?? '工作流执行失败');
    }
    // 取消是正常终态之外的主动中止，用专用错误让 worker 落 canceled 且不重试。
    if (ctx.status === 'canceled') throw new RunCanceledError();
  };
}

/** 把共享目录内的相对/绝对引用解析为绝对路径，越界即拒绝。 */
export function resolveServerPath(sharedDirs: string[], rel: string): string {
  const bases = sharedDirs.map((d) => resolve(d));
  const candidates = rel.startsWith('/') ? [resolve(rel)] : bases.map((b) => join(b, rel));
  for (const abs of candidates) {
    if (bases.some((b) => abs === b || abs.startsWith(b + sep))) return abs;
  }
  throw new Error(`路径不在允许的共享目录内：${rel}`);
}

function loadWorkflow(row: WorkflowRow): Workflow {
  const payload = JSON.parse(row.payload) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  return {
    id: row.id,
    name: row.name,
    nodes: payload.nodes ?? [],
    edges: payload.edges ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRunService(deps: RunServiceDeps): RunService {
  const { db, config, recorder } = deps;
  const runs = runsRepo(db);
  const workflows = workflowsRepo(db);
  const files = workflowFilesRepo(db);
  const mappings = pathMappingsRepo(db);
  const connections = connectionsRepo(db);
  const workflowConnections = workflowConnectionsRepo(db);
  const executor = deps.executor ?? makeDefaultExecutor(deps.writeModel);
  const sem = createSemaphore(deps.concurrency ?? config.maxConcurrentRuns);

  type RunParams = Pick<RunExecutorInput, 'targetNodeId' | 'freezeToken' | 'reuseToken'>;
  /** 运行参数（内存态）：队列式运行在 worker 内读取，无需为此扩展 DB 列。 */
  const runParams = new Map<string, RunParams>();

  let pending = 0;
  let idleResolvers: Array<() => void> = [];

  function settle(): void {
    pending -= 1;
    if (pending === 0) {
      const waiters = idleResolvers;
      idleResolvers = [];
      for (const w of waiters) w();
    }
  }

  const RUN_TERMINAL = new Set<RunStatus>(['success', 'error', 'canceled']);
  const runWaiters = new Map<string, Array<(status: RunStatus) => void>>();

  /** run 到达终态后唤醒全部等待者；行已丢失时按 error 兜底。 */
  function notifyRunFinished(runId: string): void {
    const waiters = runWaiters.get(runId);
    if (!waiters) return;
    runWaiters.delete(runId);
    const row = runs.findById(runId);
    for (const w of waiters) w(row?.status ?? 'error');
  }

  function resolveConnections(rows: PathMappingRow[]): Map<string, ResolvedConnection> {
    const map = new Map<string, ResolvedConnection>();
    for (const r of rows) {
      if (r.target_type !== 'connection' || !r.target_ref) continue;
      const conn = connections.findById(r.target_ref);
      if (!conn) continue;
      map.set(conn.id, {
        id: conn.id,
        config: decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')),
      });
    }
    return map;
  }

  function resolveWorkflowConnections(workflowId: string): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of workflowConnections.listByWorkflow(workflowId)) {
      map.set(row.node_id, decryptConfig(row.config_encrypted, config.encryptionKey));
    }
    return map;
  }

  function buildRuntime(run: RunRow): Workflow {
    const row = workflows.findById(run.workflow_id);
    if (!row) throw new Error('工作流不存在');
    const workflow = loadWorkflow(row);
    const maps = mappings.listByWorkflow(run.workflow_id);
    const mapperDeps: MapperDeps = {
      uploadDir: config.uploadDir,
      outputDir: config.outputDir,
      resourceDir: config.resourceDir,
      resolveServerPath: (rel) => resolveServerPath(config.sharedDirs, rel),
      connections: resolveConnections(maps),
      workflowConnections: resolveWorkflowConnections(run.workflow_id),
      resolveConnectionById: (id) => {
        const conn = connections.findById(id);
        return conn ? decryptConfig(conn.config_encrypted, config.encryptionKey) : undefined;
      },
    };
    return buildRuntimeWorkflow({
      workflow,
      mappings: maps,
      files: files.listByWorkflow(run.workflow_id),
      deps: mapperDeps,
      workflowId: run.workflow_id,
      runId: run.id,
    });
  }

  async function worker(run: RunRow): Promise<void> {
    try {
      const startedAt = Date.now();
      const params = runParams.get(run.id);
      runParams.delete(run.id);
      let runtime: Workflow;
      try {
        runtime = buildRuntime(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runs.finish(run.id, { status: 'error', finishedAt: startedAt, durationMs: 0, error: message });
        return;
      }

      runs.markRunning(run.id, startedAt);
      let lastError: string | null = null;
      let canceled = false;

      for (let attempt = 0; attempt <= config.runMaxRetries; attempt += 1) {
        let engineRunId: string | null = null;
        try {
          await executor({
            runId: run.id,
            workflow: runtime,
            ...params,
            onEngineRunId: (id) => {
              engineRunId = id;
              runs.setEngineRunId(run.id, id);
              recorder.attach(run.id, id, runtime);
            },
          });
          lastError = null;
          break;
        } catch (err) {
          // 取消不重试：用户意图是立刻停下，重跑会带来更多副作用。
          if (err instanceof RunCanceledError) {
            canceled = true;
            lastError = null;
            break;
          }
          lastError = err instanceof Error ? err.message : String(err);
        } finally {
          if (engineRunId) {
            recorder.detach(engineRunId);
            engineRunId = null;
          }
        }
      }

      const finishedAt = Date.now();
      runs.finish(run.id, {
        status: canceled ? 'canceled' : lastError === null ? 'success' : 'error',
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: lastError,
      });
    } finally {
      notifyRunFinished(run.id);
    }
  }

  return {
    trigger(workflowId, opts = {}) {
      const workflow = workflows.findById(workflowId);
      if (!workflow) throw new Error('工作流不存在');
      if (opts.freezeToken && !opts.targetNodeId) throw new Error('缓存至此需要指定目标节点');
      const run = runs.create({
        workflowId,
        scheduleId: opts.scheduleId ?? null,
        triggerType: opts.triggerType ?? 'manual',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'queued',
        jobRunId: opts.jobRunId ?? null,
      });
      runParams.set(run.id, {
        ...(opts.targetNodeId ? { targetNodeId: opts.targetNodeId } : {}),
        ...(opts.freezeToken ? { freezeToken: opts.freezeToken } : {}),
        ...(opts.cacheToken ? { reuseToken: opts.cacheToken } : {}),
      });
      pending += 1;
      void sem
        .run(() => worker(run))
        .catch(() => {
          /* worker 已把失败落库，此处仅防未捕获拒绝 */
        })
        .finally(settle);
      return run;
    },
    cancel(runId) {
      const row = runs.findById(runId);
      // 排队中/已结束的运行没有可中止的引擎会话。
      if (!row || row.status !== 'running' || !row.engine_run_id) return false;
      return cancelEngineRun(row.engine_run_id);
    },
    awaitRun(runId) {
      const row = runs.findById(runId);
      if (row && RUN_TERMINAL.has(row.status)) return Promise.resolve(row.status);
      return new Promise<RunStatus>((resolve) => {
        const list = runWaiters.get(runId) ?? [];
        list.push(resolve);
        runWaiters.set(runId, list);
      });
    },
    whenIdle() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((res) => {
        idleResolvers.push(res);
      });
    },
  };
}
