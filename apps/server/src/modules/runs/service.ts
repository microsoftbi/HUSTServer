import { createRun, executeWorkflow, type Workflow, type WorkflowEdge, type WorkflowNode } from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import { join, resolve, sep } from 'node:path';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { buildRuntimeWorkflow, type MapperDeps, type ResolvedConnection } from '../workflows/mapper.js';
import { pathMappingsRepo, workflowFilesRepo, workflowsRepo, type PathMappingRow, type WorkflowRow } from '../workflows/repo.js';
import { createSemaphore } from './queue.js';
import type { Recorder } from './recorder.js';
import { runsRepo, type RunRow, type TriggerType } from './repo.js';

export interface RunExecutorInput {
  runId: string;
  workflow: Workflow;
  onEngineRunId(engineRunId: string): void;
}

export type RunExecutor = (input: RunExecutorInput) => Promise<void>;

export interface RunServiceDeps {
  db: Database;
  config: AppConfig;
  recorder: Recorder;
  executor?: RunExecutor;
  concurrency?: number;
}

export interface RunService {
  trigger(
    workflowId: string,
    opts?: { triggerType?: TriggerType; scheduleId?: string | null; triggeredBy?: string | null },
  ): RunRow;
  whenIdle(): Promise<void>;
}

/** 默认执行器：走 vendored 引擎（createRun + executeWorkflow）。 */
const defaultExecutor: RunExecutor = async ({ workflow, onEngineRunId }) => {
  const ctx = await createRun(workflow);
  onEngineRunId(ctx.runId);
  await executeWorkflow(ctx.runId);
  // 引擎在节点失败时只置状态、不抛异常；若不在此显式抛出，
  // worker 会把真实失败误记为 success 并跳过重试。
  if (ctx.status === 'error') {
    const failed = [...ctx.nodeResults.values()].find((result) => result.status === 'error');
    throw new Error(failed?.error ?? '工作流执行失败');
  }
};

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
  const executor = deps.executor ?? defaultExecutor;
  const sem = createSemaphore(deps.concurrency ?? config.maxConcurrentRuns);

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

  function buildRuntime(run: RunRow): Workflow {
    const row = workflows.findById(run.workflow_id);
    if (!row) throw new Error('工作流不存在');
    const workflow = loadWorkflow(row);
    const maps = mappings.listByWorkflow(run.workflow_id);
    const mapperDeps: MapperDeps = {
      uploadDir: config.uploadDir,
      outputDir: config.outputDir,
      resolveServerPath: (rel) => resolveServerPath(config.sharedDirs, rel),
      connections: resolveConnections(maps),
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
    const startedAt = Date.now();
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

    for (let attempt = 0; attempt <= config.runMaxRetries; attempt += 1) {
      let engineRunId: string | null = null;
      try {
        await executor({
          runId: run.id,
          workflow: runtime,
          onEngineRunId: (id) => {
            engineRunId = id;
            runs.setEngineRunId(run.id, id);
            recorder.attach(run.id, id, runtime);
          },
        });
        lastError = null;
        break;
      } catch (err) {
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
      status: lastError === null ? 'success' : 'error',
      finishedAt,
      durationMs: finishedAt - startedAt,
      error: lastError,
    });
  }

  return {
    trigger(workflowId, opts = {}) {
      const workflow = workflows.findById(workflowId);
      if (!workflow) throw new Error('工作流不存在');
      const run = runs.create({
        workflowId,
        scheduleId: opts.scheduleId ?? null,
        triggerType: opts.triggerType ?? 'manual',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'queued',
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
    whenIdle() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((res) => {
        idleResolvers.push(res);
      });
    },
  };
}
