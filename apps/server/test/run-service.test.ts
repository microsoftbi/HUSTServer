import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createRecorder } from '../src/modules/runs/recorder.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import type { RunStatus } from '../src/modules/runs/repo.js';
import { createRunService, type RunExecutor } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const PAYLOAD = JSON.stringify({
  nodes: [{ id: 'n1', kind: 'inputCsv', name: 'A', position: { x: 0, y: 0 }, config: { path: '/o/a.csv' } }],
  edges: [],
});

let db: Database.Database;
let workflowId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  const owner = usersRepo(db).create({ username: 'alice', passwordHash: 'x', roles: ['workflow_author'] });
  workflowId = workflowsRepo(db).create({ ownerId: owner.id, name: 'A', payload: PAYLOAD }).id;
});

describe('createRunService', () => {
  it('触发后落库为 queued，执行成功置 success 并记录 engineRunId', async () => {
    const recorder = createRecorder(db);
    const service = createRunService({
      db,
      config: cfg,
      recorder,
      executor: async ({ onEngineRunId }) => onEngineRunId('eng-1'),
    });
    const run = service.trigger(workflowId, { triggerType: 'manual' });
    expect(run.status).toBe('queued');
    await service.whenIdle();
    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('success');
    expect(detail.engine_run_id).toBe('eng-1');
    expect(detail.finished_at).not.toBeNull();
    recorder.dispose();
  });

  it('执行失败按 runMaxRetries 重试后置 error', async () => {
    const recorder = createRecorder(db);
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      throw new Error(`失败第 ${calls} 次`);
    };
    const service = createRunService({ db, config: cfg, recorder, executor });
    const run = service.trigger(workflowId);
    await service.whenIdle();
    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe(`失败第 ${calls} 次`);
    expect(calls).toBe(cfg.runMaxRetries + 1);
    recorder.dispose();
  });

  it('并发受 concurrency 限制', async () => {
    const recorder = createRecorder(db);
    let active = 0;
    let peak = 0;
    const executor: RunExecutor = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    const service = createRunService({ db, config: cfg, recorder, executor, concurrency: 2 });
    for (let i = 0; i < 5; i += 1) service.trigger(workflowId);
    await service.whenIdle();
    expect(peak).toBe(2);
    expect(runsRepo(db).countByWorkflow(workflowId)).toBe(5);
    expect(runsRepo(db).listByWorkflow(workflowId, { limit: 10, offset: 0 }).every((r) => r.status === 'success')).toBe(true);
    recorder.dispose();
  });

  it('工作流不存在时抛错', () => {
    const service = createRunService({ db, config: cfg, recorder: createRecorder(db), executor: async () => {} });
    expect(() => service.trigger('missing')).toThrow('工作流不存在');
  });

  it('awaitRun 等待终态并返回状态；已终态立即返回', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const recorder = createRecorder(db);
    const service = createRunService({ db, config: cfg, recorder, executor: async () => { await gate; } });
    const run = service.trigger(workflowId);
    let resolved: RunStatus | undefined;
    const waiter = service.awaitRun(run.id).then((s) => { resolved = s; return s; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBeUndefined(); // 尚未终态，仍挂起
    release();
    await expect(waiter).resolves.toBe('success');
    expect(await service.awaitRun(run.id)).toBe('success'); // 已终态立即返回
    recorder.dispose();
  });
});
