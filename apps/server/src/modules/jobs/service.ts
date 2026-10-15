import type { SqlServerConnection } from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { createSemaphore } from '../runs/queue.js';
import { runsRepo } from '../runs/repo.js';
import type { RunService } from '../runs/service.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo, type JobRunRow, type JobStepRunRow } from './repo.js';
import { defaultSqlExecutor, type SqlExecutor } from './sql.js';

export interface JobServiceDeps {
  db: Database;
  config: AppConfig;
  runService: RunService;
  sqlExecutor?: SqlExecutor;
}

export interface JobService {
  trigger(jobId: string, opts?: { triggerType?: 'manual' | 'schedule'; triggeredBy?: string | null }): JobRunRow;
  whenIdle(): Promise<void>;
}

export function createJobService(deps: JobServiceDeps): JobService {
  const { db, config, runService } = deps;
  const jobs = jobsRepo(db);
  const jobRuns = jobRunsRepo(db);
  const stepRuns = jobStepRunsRepo(db);
  const connections = connectionsRepo(db);
  const runs = runsRepo(db);
  const runSql = deps.sqlExecutor ?? defaultSqlExecutor;
  // Job 级独立信号量（并发 1）：绝不复用 run 的信号量，否则 workflow 步骤会死锁
  const sem = createSemaphore(1);

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

  /** 执行单个步骤并落 job_step_runs；永不抛出（异常归一为步骤失败）。 */
  async function executeStep(step: JobStepRunRow, jobRun: JobRunRow): Promise<{ ok: boolean; error: string | null }> {
    const startedAt = Date.now();
    stepRuns.markRunning(step.id, startedAt);
    let output: string | null = null;
    const done = (ok: boolean, error: string | null): { ok: boolean; error: string | null } => {
      const finishedAt = Date.now();
      stepRuns.finish(step.id, {
        status: ok ? 'success' : 'error',
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
        const status = await runService.awaitRun(run.id);
        if (status !== 'success') {
          return done(false, runs.findById(run.id)?.error ?? '工作流执行失败');
        }
        return done(true, null);
      }
      const stepCfg = JSON.parse(step.config) as { connectionId?: string; sql?: string };
      if (!stepCfg.connectionId) throw new Error('步骤缺少 connectionId');
      if (!stepCfg.sql?.trim()) throw new Error('SQL 不能为空');
      const conn = connections.findById(stepCfg.connectionId);
      if (!conn) throw new Error('连接不存在');
      const connConfig = decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')) as unknown as SqlServerConnection;
      const result = await runSql(connConfig, stepCfg.sql);
      output = JSON.stringify(result);
      return done(true, null);
    } catch (err) {
      return done(false, err instanceof Error ? err.message : String(err));
    }
  }

  async function worker(jobRun: JobRunRow): Promise<void> {
    const startedAt = Date.now();
    try {
      jobRuns.markRunning(jobRun.id, startedAt);
      const steps = stepRuns.listByJobRun(jobRun.id);
      let anyFailed = false;
      for (const step of steps) {
        if (step.status !== 'pending') continue;
        const result = await executeStep(step, jobRun);
        if (!result.ok) {
          anyFailed = true;
          if (step.on_failure === 'abort') {
            stepRuns.skipRemaining(jobRun.id, step.seq + 1);
            const finishedAt = Date.now();
            jobRuns.finish(jobRun.id, {
              status: 'error', finishedAt, durationMs: finishedAt - startedAt, error: result.error,
            });
            return;
          }
        }
      }
      const finishedAt = Date.now();
      jobRuns.finish(jobRun.id, {
        status: anyFailed ? 'error' : 'success',
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: anyFailed ? '部分步骤执行失败' : null,
      });
    } finally {
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

  return {
    trigger(jobId, opts = {}) {
      const job = jobs.findById(jobId);
      if (!job) throw new Error('Job 不存在');
      const steps = jobs.listSteps(jobId);
      if (steps.length === 0) throw new Error('Job 没有可执行的步骤');
      const jobRun = jobRuns.create({
        jobId,
        triggerType: opts.triggerType ?? 'manual',
        triggeredBy: opts.triggeredBy ?? null,
      });
      stepRuns.createBatch(jobRun.id, steps.map((s) => ({
        stepId: s.id, seq: s.seq, type: s.type, name: s.name, config: s.config, onFailure: s.on_failure,
      })));
      pending += 1;
      void sem
        .run(() => worker(jobRun))
        .catch(() => {
          /* worker 的 finally 已兜底落库，此处仅防未捕获拒绝 */
        })
        .finally(settle);
      return jobRun;
    },
    whenIdle() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((res) => {
        idleResolvers.push(res);
      });
    },
  };
}
