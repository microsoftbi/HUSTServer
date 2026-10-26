import type { SqlServerConnection } from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import type { LoadModelConfig, ModelStore } from '../models/service.js';
import { createSemaphore } from '../runs/queue.js';
import { runsRepo } from '../runs/repo.js';
import type { RunService } from '../runs/service.js';
import {
  assertAcyclic, buildChildren, descendantsOf, disabledKeys, executableCount, topoOrder,
} from './graph.js';
import {
  jobRunsRepo, jobStepRunsRepo, jobsRepo,
  type JobEdgeInput, type JobGraphSnapshot, type JobRunRow, type JobStepRunRow, type JobStepRunStatus,
} from './repo.js';
import { defaultSqlExecutor, type SqlExecutor } from './sql.js';

export interface JobServiceDeps {
  db: Database;
  config: AppConfig;
  runService: RunService;
  sqlExecutor?: SqlExecutor;
  modelStore?: ModelStore;
}

export interface JobService {
  trigger(jobId: string, opts?: { triggerType?: 'manual' | 'schedule'; triggeredBy?: string | null }): JobRunRow;
  cancel(jobRunId: string): boolean;
  whenIdle(): Promise<void>;
}

/** v1 串行：同一时刻只执行一个节点。将来放开并行只需调大。 */
const MAX_PARALLEL = 1;

interface ActiveEntry {
  cancelled: boolean;
  /** 当前运行中的 workflow run，取消时用于中止引擎会话。 */
  runIds: Set<string>;
}

export function createJobService(deps: JobServiceDeps): JobService {
  const { db, config, runService } = deps;
  const jobs = jobsRepo(db);
  const jobRuns = jobRunsRepo(db);
  const stepRuns = jobStepRunsRepo(db);
  const connections = connectionsRepo(db);
  const runs = runsRepo(db);
  const runSql = deps.sqlExecutor ?? defaultSqlExecutor;
  const modelStore = deps.modelStore;
  // Job 级独立信号量（并发 1）：绝不复用 run 的信号量，否则 workflow 步骤会死锁
  const sem = createSemaphore(1);
  const active = new Map<string, ActiveEntry>();

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

  /** 执行单个节点并落 job_step_runs；永不抛出（异常归一为节点失败）。 */
  async function executeNode(
    step: JobStepRunRow,
    jobRun: JobRunRow,
    entry: ActiveEntry | undefined,
  ): Promise<{ ok: boolean; error: string | null }> {
    const startedAt = Date.now();
    stepRuns.markRunning(step.id, startedAt);
    let output: string | null = null;
    const done = (
      ok: boolean,
      error: string | null,
      status?: JobStepRunStatus,
    ): { ok: boolean; error: string | null } => {
      const finishedAt = Date.now();
      stepRuns.finish(step.id, {
        status: status ?? (ok ? 'success' : 'error'),
        finishedAt,
        durationMs: finishedAt - startedAt,
        error,
        output,
      });
      return { ok, error };
    };
    try {
      if (step.type === 'workflow') {
        const stepCfg = JSON.parse(step.config) as { workflowId?: string };
        if (!stepCfg.workflowId) throw new Error('步骤缺少 workflowId');
        const run = runService.trigger(stepCfg.workflowId, {
          triggerType: 'job',
          triggeredBy: jobRun.triggered_by,
          jobRunId: jobRun.id,
        });
        output = JSON.stringify({ runId: run.id });
        entry?.runIds.add(run.id);
        let status;
        try {
          status = await runService.awaitRun(run.id);
        } finally {
          entry?.runIds.delete(run.id);
        }
        if (status === 'canceled') return done(false, '用户取消', 'canceled');
        if (status !== 'success') {
          return done(false, runs.findById(run.id)?.error ?? '工作流执行失败');
        }
        return done(true, null);
      }
      if (step.type === 'sql') {
        const stepCfg = JSON.parse(step.config) as { connectionId?: string; sql?: string };
        if (!stepCfg.connectionId) throw new Error('步骤缺少 connectionId');
        if (!stepCfg.sql?.trim()) throw new Error('SQL 不能为空');
        const conn = connections.findById(stepCfg.connectionId);
        if (!conn) throw new Error('连接不存在');
        const connConfig = decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')) as unknown as SqlServerConnection;
        const result = await runSql(connConfig, stepCfg.sql);
        output = JSON.stringify(result);
        return done(true, null);
      }
      if (step.type === 'load_model') {
        if (!modelStore) throw new Error('模型存储未配置');
        const stepCfg = JSON.parse(step.config) as LoadModelConfig;
        const job = jobs.findById(jobRun.job_id); // 模型归属 = Job 的 owner
        const result = await modelStore.load(stepCfg, job?.owner_id ?? null);
        output = JSON.stringify({ modelName: stepCfg.modelName, rowCount: result.rowCount });
        return done(true, null);
      }
      throw new Error(`未知步骤类型：${step.type}`);
    } catch (err) {
      return done(false, err instanceof Error ? err.message : String(err));
    }
  }

  /** 把运行快照摊平成调度所需的邻接关系与状态集合。 */
  async function worker(jobRun: JobRunRow, graph: JobGraphSnapshot): Promise<void> {
    const startedAt = Date.now();
    const entry = active.get(jobRun.id);
    const cancelled = (): boolean => entry?.cancelled === true;
    try {
      // 排队的运行可能已被取消：直接退出，避免覆盖 canceled 终态
      const cur = jobRuns.findById(jobRun.id);
      if (!cur || (cur.status !== 'queued' && cur.status !== 'running')) return;
      jobRuns.markRunning(jobRun.id, startedAt);

      const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
      const rows = new Map<string, JobStepRunRow>();
      for (const row of stepRuns.listByJobRun(jobRun.id)) {
        if (row.node_key) rows.set(row.node_key, row);
      }

      const nodesList = graph.nodes.map((n) => ({ key: n.key, mode: n.mode }));
      const disabled = disabledKeys(nodesList, graph.edges);
      // 禁用节点与主动跳过节点：记 skipped，不进入执行队列
      const skipped = new Set(disabled);
      for (const n of graph.nodes) {
        if (!disabled.has(n.key) && n.mode === 'skip') skipped.add(n.key);
      }
      stepRuns.markSkipped(jobRun.id, [...skipped], 'skipped');

      const children = buildChildren(graph.edges);
      const indegree = new Map<string, number>(graph.nodes.map((n) => [n.key, 0]));
      for (const e of graph.edges) {
        if (!indegree.has(e.target)) continue;
        indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
      }

      // 跳过节点视为「已满足」：立刻释放其下游
      const release = (key: string): void => {
        for (const child of children.get(key) ?? []) {
          if (!nodes.has(child)) continue;
          const left = (indegree.get(child) ?? 0) - 1;
          indegree.set(child, left);
          if (left !== 0) continue;
          if (!skipped.has(child)) ready.push(child);
        }
      };

      // 同层按 seq（保存顺序）稳定排序，保证同一张图多次运行顺序一致
      const seqOf = (k: string): number => nodes.get(k)?.seq ?? 0;
      const ready: string[] = [];
      for (const [k, d] of indegree) {
        if (d === 0 && !skipped.has(k)) ready.push(k);
      }
      ready.sort((a, b) => seqOf(a) - seqOf(b));

      for (const key of skipped) {
        if (nodes.get(key)?.mode === 'skip') release(key);
      }

      const running = new Set<Promise<void>>();
      let firstError: string | null = null;

      while ((!cancelled() && ready.length > 0) || running.size > 0) {
        while (!cancelled() && ready.length > 0 && running.size < MAX_PARALLEL) {
          ready.sort((a, b) => seqOf(a) - seqOf(b));
          const key = ready.shift()!;
          const node = nodes.get(key)!;
          const row = rows.get(key);
          if (!row) {
            release(key);
            continue;
          }
          const task = executeNode(row, jobRun, entry).then((result) => {
            if (cancelled()) return;
            if (result.ok || node.onFailure === 'continue') {
              if (!result.ok) firstError ??= result.error;
              release(key);
            } else {
              firstError ??= result.error;
              // 中止：只跳过本节点的可达后代，兄弟分支继续
              const dead = descendantsOf(key, graph.edges).filter((k) => !disabled.has(k));
              stepRuns.markSkipped(jobRun.id, dead, 'skipped');
            }
          });
          running.add(task);
          void task.finally(() => running.delete(task));
        }
        if (running.size > 0) await Promise.race(running);
        else break;
      }

      if (cancelled()) {
        stepRuns.markSkipped(jobRun.id, graph.nodes.map((n) => n.key), 'canceled');
        const now = jobRuns.findById(jobRun.id);
        if (now && (now.status === 'queued' || now.status === 'running')) {
          const finishedAt = Date.now();
          jobRuns.finish(jobRun.id, {
            status: 'canceled', finishedAt, durationMs: finishedAt - startedAt, error: '用户取消',
          });
        }
        return;
      }

      const finishedAt = Date.now();
      jobRuns.finish(jobRun.id, {
        status: firstError ? 'error' : 'success',
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: firstError,
      });
    } finally {
      active.delete(jobRun.id);
      // 兜底：意外终止时仍处于 queued/running 的 job_run 置 error，避免永远挂起
      const cur = jobRuns.findById(jobRun.id);
      if (cur && (cur.status === 'queued' || cur.status === 'running')) {
        const finishedAt = Date.now();
        jobRuns.finish(jobRun.id, {
          status: 'error', finishedAt, durationMs: finishedAt - startedAt, error: 'Job worker 意外终止',
        });
      }
    }
  }

  /** 由当前节点与边构造运行快照（配置 JSON 解析为对象）。 */
  function buildSnapshot(jobId: string, edges: JobEdgeInput[]): JobGraphSnapshot {
    return {
      version: 1,
      nodes: jobs.listNodes(jobId).map((n) => ({
        key: n.node_key ?? n.id,
        seq: n.seq,
        type: n.type,
        name: n.name,
        onFailure: n.on_failure,
        mode: n.run_mode,
        x: n.pos_x,
        y: n.pos_y,
        config: JSON.parse(n.config) as Record<string, unknown>,
      })),
      edges,
    };
  }

  return {
    trigger(jobId, opts = {}) {
      const job = jobs.findById(jobId);
      if (!job) throw new Error('Job 不存在');
      const edges = jobs.listEdges(jobId).map((e) => ({ source: e.source_key, target: e.target_key }));
      const snapshot = buildSnapshot(jobId, edges);
      if (snapshot.nodes.length === 0) throw new Error('没有可执行的节点');
      const keys = snapshot.nodes.map((n) => n.key);
      assertAcyclic(keys, edges);
      const nodesList = snapshot.nodes.map((n) => ({ key: n.key, mode: n.mode }));
      if (executableCount(nodesList, edges) === 0) throw new Error('没有可执行的节点');

      const jobRun = jobRuns.create({
        jobId,
        triggerType: opts.triggerType ?? 'manual',
        triggeredBy: opts.triggeredBy ?? null,
        graphSnapshot: JSON.stringify(snapshot),
      });
      const byKey = new Map(snapshot.nodes.map((n) => [n.key, n]));
      stepRuns.createBatch(jobRun.id, topoOrder(keys, edges).map((key, i) => {
        const node = byKey.get(key)!;
        return {
          stepId: null,
          nodeKey: key,
          seq: i,
          type: node.type,
          name: node.name,
          config: JSON.stringify(node.config),
          onFailure: node.onFailure,
        };
      }));
      active.set(jobRun.id, { cancelled: false, runIds: new Set() });
      pending += 1;
      void sem
        .run(() => worker(jobRun, snapshot))
        .catch(() => {
          /* worker 的 finally 已兜底落库，此处仅防未捕获拒绝 */
        })
        .finally(settle);
      return jobRun;
    },
    cancel(jobRunId) {
      const jobRun = jobRuns.findById(jobRunId);
      if (!jobRun) return false;
      if (jobRun.status !== 'queued' && jobRun.status !== 'running') return false;

      const entry = active.get(jobRunId);
      if (entry) {
        entry.cancelled = true;
        for (const runId of entry.runIds) {
          try {
            runService.cancel(runId);
          } catch {
            /* 运行已结束 */
          }
        }
      }
      const pendingKeys = stepRuns
        .listByJobRun(jobRunId)
        .filter((s) => s.status === 'pending' && s.node_key)
        .map((s) => s.node_key!);
      stepRuns.markSkipped(jobRunId, pendingKeys, 'canceled');

      const finishedAt = Date.now();
      const startedAt = jobRun.started_at ?? jobRun.created_at;
      jobRuns.finish(jobRunId, {
        status: 'canceled', finishedAt, durationMs: finishedAt - startedAt, error: '用户取消',
      });
      return true;
    },
    whenIdle() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((res) => {
        idleResolvers.push(res);
      });
    },
  };
}
