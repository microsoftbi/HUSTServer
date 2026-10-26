import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import {
  jobRunsRepo, jobStepRunsRepo, jobsRepo,
  type JobEdgeInput, type JobNodeInput, type JobNodeMode, type JobOnFailure,
} from '../src/modules/jobs/repo.js';
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

interface NodeOpts {
  onFailure?: JobOnFailure;
  mode?: JobNodeMode;
}

function wfNode(key: string, workflowId: string, opts: NodeOpts = {}): JobNodeInput {
  return {
    key, type: 'workflow', name: `工作流-${key}`, config: JSON.stringify({ workflowId }),
    onFailure: opts.onFailure ?? 'abort', mode: opts.mode ?? 'run', x: 0, y: 0,
  };
}
function sqlNode(key: string, opts: NodeOpts = {}): JobNodeInput {
  return {
    key, type: 'sql', name: `SQL-${key}`, config: JSON.stringify({ connectionId: 'c1', sql: 'SELECT 1' }),
    onFailure: opts.onFailure ?? 'abort', mode: opts.mode ?? 'run', x: 0, y: 0,
  };
}
function loadModelNode(key: string, opts: NodeOpts = {}): JobNodeInput {
  return {
    key, type: 'load_model', name: `模型-${key}`,
    config: JSON.stringify({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }),
    onFailure: opts.onFailure ?? 'abort', mode: opts.mode ?? 'run', x: 0, y: 0,
  };
}
const edge = (source: string, target: string): JobEdgeInput => ({ source, target });
const chain = (nodes: JobNodeInput[]): JobEdgeInput[] =>
  nodes.slice(1).map((n, i) => edge(nodes[i].key, n.key));

/** sql 步骤需连接存在；「连接不存在」用例故意不 seed。 */
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
    cancel: () => true,
    async whenIdle() {},
    async awaitRun() {
      return outcome;
    },
  } as unknown as RunService & { calls: string[] };
}

/** 可控 RunService：awaitRun 挂起，直到测试调用 release()，用于取消/快照隔离。 */
function deferredRunService() {
  let waiters: Array<(s: RunStatus) => void> = [];
  const calls: string[] = [];
  const settle = (status: RunStatus): void => {
    const list = waiters;
    waiters = [];
    for (const w of list) w(status);
  };
  const service = {
    calls,
    trigger(workflowIdArg: string, opts?: { triggerType?: string; triggeredBy?: string | null; jobRunId?: string | null }) {
      calls.push(workflowIdArg);
      return runsRepo(db).create({
        workflowId: workflowIdArg,
        triggerType: (opts?.triggerType as 'job' | 'manual') ?? 'manual',
        triggeredBy: opts?.triggeredBy ?? null,
        jobRunId: opts?.jobRunId ?? null,
      });
    },
    // 真实实现里取消会让等待中的 run 以 canceled 收尾
    cancel: () => {
      settle('canceled');
      return true;
    },
    async whenIdle() {},
    awaitRun() {
      return new Promise<RunStatus>((resolve) => waiters.push(resolve));
    },
  };
  return { service: service as unknown as RunService, calls, release: settle, waiting: () => waiters.length };
}

/** 等待条件成立（微任务轮询），用于「运行进入执行中」这类异步时序断言。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const BASE = { description: null, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' } as const;

let db: Database.Database;
let ownerId: string;
let workflowId: string;

function createJob(nodes: JobNodeInput[], edges: JobEdgeInput[] = []) {
  return jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, nodes, edges });
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', roles: ['workflow_author'] }).id;
  workflowId = workflowsRepo(db).create({ ownerId, name: 'W', payload: WF_PAYLOAD }).id;
});

describe('createJobService', () => {
  it('全部成功 → success；workflow/sql 节点 output 符合契约', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 3, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    const nodes = [wfNode('a', workflowId), sqlNode('b')];
    const job = createJob(nodes, chain(nodes));
    const jobRun = service.trigger(job.id);
    expect(jobRun.status).toBe('queued');
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('success');
    expect(detail.error).toBeNull();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['success', 'success']);
    expect(steps.map((s) => s.node_key)).toEqual(['a', 'b']);
    expect(JSON.parse(steps[0].output!)).toEqual({ runId: expect.any(String) });
    expect(JSON.parse(steps[1].output!)).toEqual({ rowsAffected: 3, rowCount: 0 });
    expect(runService.calls).toEqual([workflowId]);
  });

  it('abort：节点失败只跳过其可达后代，兄弟分支继续执行', async () => {
    const runService = fakeRunService('error');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    // a(fail) → b；c 独立分支
    const job = createJob(
      [wfNode('a', workflowId, { onFailure: 'abort' }), sqlNode('b'), sqlNode('c')],
      [edge('a', 'b')],
    );
    const jobRun = service.trigger(job.id);
    await service.whenIdle();

    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('error');
    // error 取自首个失败节点，而非笼统文案
    expect(detail.error).toBe('工作流炸了');

    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    const byKey = new Map(steps.map((s) => [s.node_key, s]));
    expect(byKey.get('a')!.status).toBe('error');
    expect(byKey.get('a')!.error).toBe('工作流炸了');
    expect(byKey.get('b')!.status).toBe('skipped');
    expect(byKey.get('c')!.status).toBe('success');
  });

  it('continue：节点失败不阻断下游，最终 error 取首个失败节点错误', async () => {
    const runService = fakeRunService('error');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    const nodes = [wfNode('a', workflowId, { onFailure: 'continue' }), sqlNode('b', { onFailure: 'continue' })];
    const job = createJob(nodes, chain(nodes));
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe('工作流炸了');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['error', 'success']);
  });

  it('菱形 DAG：AND 汇合需等两条上游都完成才执行', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    // a → b, a → c, b → d, c → d
    const nodes = [sqlNode('a'), sqlNode('b'), sqlNode('c'), sqlNode('d')];
    const job = createJob(nodes, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]);
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('success');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.status === 'success')).toBe(true);
    // d 一定最后执行（拓扑序）
    expect(steps[steps.length - 1].node_key).toBe('d');
  });

  it('skip：只跳过自身，下游照常执行', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 2, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    const job = createJob(
      [sqlNode('a', { mode: 'skip' }), sqlNode('b')],
      [edge('a', 'b')],
    );
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    const byKey = new Map(steps.map((s) => [s.node_key, s]));
    expect(byKey.get('a')!.status).toBe('skipped');
    expect(byKey.get('b')!.status).toBe('success');
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('success');
  });

  it('disable：自身与全部可达下游都不执行，孤岛节点照常执行', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    // a(disable) → b → c，孤岛 d
    const job = createJob(
      [sqlNode('a', { mode: 'disable' }), sqlNode('b'), sqlNode('c'), sqlNode('d')],
      [edge('a', 'b'), edge('b', 'c')],
    );
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    const byKey = new Map(steps.map((s) => [s.node_key, s]));
    expect(byKey.get('a')!.status).toBe('skipped');
    expect(byKey.get('b')!.status).toBe('skipped');
    expect(byKey.get('c')!.status).toBe('skipped');
    expect(byKey.get('d')!.status).toBe('success');
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('success');
  });

  it('sql 节点连接不存在时节点失败', async () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    const job = createJob([sqlNode('a')]);
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toBe('连接不存在');
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('error');
  });

  it('load_model 节点调用 modelStore.load，output 为模型名与行数，ownerId 取 Job 的 owner', async () => {
    const load = vi.fn(async (_cfg: LoadModelConfig, _ownerId: string | null) => ({
      rowCount: 7,
      columns: [{ name: 'id', type: 'BIGINT' }],
    }));
    const modelStore = {
      load, query: vi.fn(), rename: vi.fn(), remove: vi.fn(), close: vi.fn(),
    } as unknown as ModelStore;
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success'), modelStore });
    const job = createJob([loadModelNode('a')]);
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

  it('未注入 modelStore 时 load_model 节点失败', async () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    const job = createJob([loadModelNode('a')]);
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toBe('模型存储未配置');
  });

  it('Job 不存在、无节点、全部禁用/跳过时抛错', () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    expect(() => service.trigger('missing')).toThrow('Job 不存在');
    expect(() => service.trigger(createJob([]).id)).toThrow('没有可执行的节点');
    // 全部禁用（含下游）→ 没有可执行节点
    expect(() => service.trigger(createJob(
      [sqlNode('a', { mode: 'disable' }), sqlNode('b')],
      [edge('a', 'b')],
    ).id)).toThrow('没有可执行的节点');
    // 全部主动跳过 → 没有可执行节点
    expect(() => service.trigger(createJob([sqlNode('a', { mode: 'skip' })]).id)).toThrow('没有可执行的节点');
  });

  it('运行快照隔离：触发后编辑 Job 不影响本次运行', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    seedConnection();
    const job = createJob([sqlNode('a'), sqlNode('b')], [edge('a', 'b')]);
    const jobRun = service.trigger(job.id);

    // 运行开始前后都把 Job 换掉
    jobsRepo(db).update(job.id, {
      name: 'J2', ...BASE, enabled: false,
      nodes: [wfNode('z', workflowId)], edges: [],
    });

    const snapshot = JSON.parse(jobRunsRepo(db).findById(jobRun.id)!.graph_snapshot!) as {
      nodes: Array<{ key: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(snapshot.nodes.map((n) => n.key)).toEqual(['a', 'b']);
    expect(snapshot.edges).toEqual([{ source: 'a', target: 'b' }]);

    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.node_key)).toEqual(['a', 'b']);
    expect(runService.calls).toEqual([]);
  });

  it('取消运行：作业落 canceled，未执行节点落 canceled，已执行节点保留结果', async () => {
    const deferred = deferredRunService();
    const service = createJobService({ db, config: cfg, runService: deferred.service, sqlExecutor: vi.fn() });
    const nodes = [wfNode('a', workflowId), sqlNode('b')];
    const job = createJob(nodes, chain(nodes));
    const jobRun = service.trigger(job.id);

    await waitFor(() => deferred.waiting() === 1);
    expect(service.cancel(jobRun.id)).toBe(true);
    await service.whenIdle();

    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('canceled');
    expect(detail.error).toBe('用户取消');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    const byKey = new Map(steps.map((s) => [s.node_key, s]));
    expect(byKey.get('a')!.status).toBe('canceled');
    expect(byKey.get('b')!.status).toBe('canceled');

    // 终态后不可重复取消
    expect(service.cancel(jobRun.id)).toBe(false);
  });
});
