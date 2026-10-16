import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo, type JobStepInput } from '../src/modules/jobs/repo.js';
import { usersRepo } from '../src/modules/users/repo.js';

const STEPS: JobStepInput[] = [
  { type: 'workflow', name: '日结', config: JSON.stringify({ workflowId: 'w1' }), onFailure: 'abort' },
  { type: 'sql', name: '归档', config: JSON.stringify({ connectionId: 'c1', sql: 'DELETE FROM t' }), onFailure: 'continue' },
];

const BASE = { ownerId: '', description: null, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' } as const;

let db: Database.Database;
let ownerId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', roles: ['workflow_author'] }).id;
});

describe('jobsRepo', () => {
  it('create/listSteps：seq 按数组下标，快照字段可回读', () => {
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: '流水线', enabled: false, steps: STEPS });
    expect(job.id).toBeTruthy();
    expect(job.enabled).toBe(0);
    const steps = jobsRepo(db).listSteps(job.id);
    expect(steps.map((s) => s.seq)).toEqual([0, 1]);
    expect(steps[1].on_failure).toBe('continue');
    expect(JSON.parse(steps[0].config)).toEqual({ workflowId: 'w1' });
  });

  it('update 整体覆盖：删除旧 steps 重插', () => {
    const repo = jobsRepo(db);
    const job = repo.create({ ...BASE, ownerId, name: 'A', enabled: false, steps: STEPS });
    const updated = repo.update(job.id, {
      name: 'B', description: 'd', enabled: true, freqType: 'daily', cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai', steps: [STEPS[1]],
    })!;
    expect(updated.name).toBe('B');
    expect(updated.enabled).toBe(1);
    expect(updated.cron_expr).toBe('0 8 * * *');
    const steps = repo.listSteps(job.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].seq).toBe(0);
  });

  it('listEnabledScheduled 只返回 enabled=1 且 cron_expr 非空', () => {
    const repo = jobsRepo(db);
    repo.create({ ...BASE, ownerId, name: '关', enabled: false, freqType: 'daily', cronExpr: '0 8 * * *', steps: STEPS });
    repo.create({ ...BASE, ownerId, name: '开但无cron', enabled: true, steps: STEPS });
    const on = repo.create({ ...BASE, ownerId, name: '开且有cron', enabled: true, freqType: 'daily', cronExpr: '0 8 * * *', steps: STEPS });
    expect(repo.listEnabledScheduled().map((j) => j.id)).toEqual([on.id]);
  });

  it('remove 级联删除 steps；listForOwner/listAll', () => {
    const repo = jobsRepo(db);
    const j1 = repo.create({ ...BASE, ownerId, name: 'j1', enabled: false, steps: STEPS });
    repo.create({ ...BASE, ownerId, name: 'j2', enabled: false, steps: STEPS });
    expect(repo.listForOwner(ownerId)).toHaveLength(2);
    expect(repo.listAll()).toHaveLength(2);
    expect(repo.remove(j1.id)).toBe(true);
    expect(repo.findById(j1.id)).toBeNull();
    expect(repo.listSteps(j1.id)).toHaveLength(0);
  });
});

describe('jobRunsRepo / jobStepRunsRepo', () => {
  it('run 生命周期、step 快照与 skipRemaining', () => {
    const jobs = jobsRepo(db);
    const runs = jobRunsRepo(db);
    const stepRuns = jobStepRunsRepo(db);
    const job = jobs.create({ ...BASE, ownerId, name: 'j', enabled: false, steps: STEPS });

    const jobRun = runs.create({ jobId: job.id, triggerType: 'manual', triggeredBy: ownerId });
    expect(jobRun.status).toBe('queued');

    stepRuns.createBatch(jobRun.id, jobs.listSteps(job.id).map((s) => ({
      stepId: s.id, seq: s.seq, type: s.type, name: s.name, config: s.config, onFailure: s.on_failure,
    })));
    const batch = stepRuns.listByJobRun(jobRun.id);
    expect(batch).toHaveLength(2);
    expect(batch.every((s) => s.status === 'pending')).toBe(true);
    expect(batch[0].config).toBe(STEPS[0].config);
    expect(batch[0].on_failure).toBe('abort');

    stepRuns.markRunning(batch[0].id, 1);
    stepRuns.finish(batch[0].id, { status: 'error', finishedAt: 2, durationMs: 1, error: 'boom' });
    expect(stepRuns.findById(batch[0].id)!.status).toBe('error');

    stepRuns.skipRemaining(jobRun.id, 1);
    expect(stepRuns.findById(batch[1].id)!.status).toBe('skipped');

    runs.markRunning(jobRun.id, 3);
    runs.finish(jobRun.id, { status: 'error', finishedAt: 5, durationMs: 2, error: 'boom' });
    expect(runs.findById(jobRun.id)!.status).toBe('error');
    expect(runs.countByJob(job.id)).toBe(1);
    expect(runs.listByJob(job.id, { limit: 10, offset: 0 })).toHaveLength(1);
  });
});
