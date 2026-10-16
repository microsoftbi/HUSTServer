import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo, type JobStepInput } from '../src/modules/jobs/repo.js';
import { createJobService } from '../src/modules/jobs/service.js';
import type { LoadModelConfig, ModelStore } from '../src/modules/models/service.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import type { RunStatus } from '../src/modules/runs/repo.js';
import type { RunService } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const WF_PAYLOAD = JSON.stringify({ nodes: [], edges: [] });

function wfStep(workflowId: string, onFailure: 'abort' | 'continue' = 'abort'): JobStepInput {
  return { type: 'workflow', name: '跑工作流', config: JSON.stringify({ workflowId }), onFailure };
}
function sqlStep(onFailure: 'abort' | 'continue' = 'abort'): JobStepInput {
  return { type: 'sql', name: '跑SQL', config: JSON.stringify({ connectionId: 'c1', sql: 'SELECT 1' }), onFailure };
}
function loadModelStep(): JobStepInput {
  return {
    type: 'load_model',
    name: '加载模型',
    config: JSON.stringify({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }),
    onFailure: 'abort',
  };
}

/** spec §5.2：sql 步骤需连接存在。仅「SQL 步骤成功」的用例seed 连接 c1；「连接不存在」用例故意不 seed。 */
function seedConnection(): void {
  db.prepare(
    'INSERT INTO connections (id,owner_id,name,type,config_encrypted,shared,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run('c1', ownerId, 'C', 'sqlserver', encryptConfig({ server: 'h', database: 'd' }, cfg.encryptionKey.toString('hex')), 0, Date.now(), Date.now());
}

/** 假 RunService：trigger 直落终态 run；awaitRun 返回预设结果。 */
function fakeRunService(outcome: RunStatus): RunService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    trigger(workflowIdArg, opts) {
      calls.push(workflowIdArg);
      const run = runsRepo(db).create({
        workflowId: workflowIdArg,
        triggerType: opts?.triggerType ?? 'manual',
        triggeredBy: opts?.triggeredBy ?? null,
        jobRunId: opts?.jobRunId ?? null,
      });
      runsRepo(db).finish(run.id, {
        status: outcome, finishedAt: Date.now(), durationMs: 0,
        error: outcome === 'error' ? '工作流炸了' : null,
      });
      return run;
    },
    async whenIdle() {},
    async awaitRun() {
      return outcome;
    },
  } as unknown as RunService & { calls: string[] };
}

const BASE = { ownerId: '', description: null, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' } as const;

let db: Database.Database;
let ownerId: string;
let workflowId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', roles: ['workflow_author'] }).id;
  workflowId = workflowsRepo(db).create({ ownerId, name: 'W', payload: WF_PAYLOAD }).id;
});

describe('createJobService', () => {
  it('全部成功 → success；workflow/sql 步骤 output 符合契约', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 3, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [wfStep(workflowId), sqlStep()] });
    const jobRun = service.trigger(job.id);
    expect(jobRun.status).toBe('queued');
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('success');
    expect(detail.error).toBeNull();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['success', 'success']);
    expect(JSON.parse(steps[0].output!)).toEqual({ runId: expect.any(String) });
    expect(JSON.parse(steps[1].output!)).toEqual({ rowsAffected: 3, rowCount: 0 });
    expect(runService.calls).toEqual([workflowId]);
  });

  it('abort：首步失败后剩余步骤 skipped，job_runs error 且 error 取自步骤', async () => {
    const runService = fakeRunService('error');
    const service = createJobService({ db, config: cfg, runService });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [wfStep(workflowId, 'abort'), sqlStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('error');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['error', 'skipped']);
    expect(steps[0].error).toBe('工作流炸了');
  });

  it('continue：首步失败仍执行后续步骤，最终 error', async () => {
    const runService = fakeRunService('error');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [wfStep(workflowId, 'continue'), sqlStep('continue')] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe('部分步骤执行失败');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['error', 'success']);
  });

  it('sql 步骤连接不存在时步骤失败', async () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [sqlStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toBe('连接不存在');
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('error');
  });

  it('load_model 步骤调用 modelStore.load，output 为模型名与行数，ownerId 取 Job 的 owner', async () => {
    const load = vi.fn(async (_cfg: LoadModelConfig, _ownerId: string | null) => ({
      rowCount: 7,
      columns: [{ name: 'id', type: 'BIGINT' }],
    }));
    const modelStore = {
      load, query: vi.fn(), rename: vi.fn(), remove: vi.fn(), close: vi.fn(),
    } as unknown as ModelStore;
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success'), modelStore });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [loadModelStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();

    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('success');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['success']);
    expect(JSON.parse(steps[0].output!)).toEqual({ modelName: 'sales_model', rowCount: 7 });
    expect(load).toHaveBeenCalledWith(
      { source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' },
      ownerId,
    );
  });

  it('未注入 modelStore 时 load_model 步骤失败', async () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [loadModelStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toBe('模型存储未配置');
  });

  it('Job 不存在或无步骤时抛错', () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    expect(() => service.trigger('missing')).toThrow('Job 不存在');
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: '空', enabled: false, steps: [] });
    expect(() => service.trigger(job.id)).toThrow('Job 没有可执行的步骤');
  });
});
