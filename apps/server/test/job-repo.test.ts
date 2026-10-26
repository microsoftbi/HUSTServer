import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  jobRunsRepo, jobStepRunsRepo, jobsRepo,
  type JobEdgeInput, type JobNodeInput,
} from '../src/modules/jobs/repo.js';
import { usersRepo } from '../src/modules/users/repo.js';

const NODES: JobNodeInput[] = [
  {
    key: 'n_a', type: 'workflow', name: '日结', config: JSON.stringify({ workflowId: 'w1' }),
    onFailure: 'abort', mode: 'run', x: 80, y: 120,
  },
  {
    key: 'n_b', type: 'sql', name: '归档', config: JSON.stringify({ connectionId: 'c1', sql: 'DELETE FROM t' }),
    onFailure: 'continue', mode: 'skip', x: 340, y: 120,
  },
];
const EDGES: JobEdgeInput[] = [{ source: 'n_a', target: 'n_b' }];

const BASE = { ownerId: '', description: null, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' } as const;

let db: Database.Database;
let ownerId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', roles: ['workflow_author'] }).id;
});

describe('jobsRepo', () => {
  it('create/listNodes/listEdges：seq 按下标、key/坐标/模式/失败策略可回读', () => {
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: '流水线', enabled: false, nodes: NODES, edges: EDGES });
    expect(job.id).toBeTruthy();
    expect(job.enabled).toBe(0);

    const nodes = jobsRepo(db).listNodes(job.id);
    expect(nodes.map((n) => n.seq)).toEqual([0, 1]);
    expect(nodes.map((n) => n.node_key)).toEqual(['n_a', 'n_b']);
    expect(nodes[0].pos_x).toBe(80);
    expect(nodes[0].pos_y).toBe(120);
    expect(nodes[1].run_mode).toBe('skip');
    expect(nodes[1].on_failure).toBe('continue');
    expect(JSON.parse(nodes[0].config)).toEqual({ workflowId: 'w1' });

    expect(jobsRepo(db).listEdges(job.id).map((e) => ({ source: e.source_key, target: e.target_key })))
      .toEqual(EDGES);
  });

  it('update 全量覆盖图：边与节点整体重插，node_key 保持不变', () => {
    const repo = jobsRepo(db);
    const job = repo.create({ ...BASE, ownerId, name: 'A', enabled: false, nodes: NODES, edges: EDGES });
    const updated = repo.update(job.id, {
      name: 'B', description: 'd', enabled: true, freqType: 'daily', cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      nodes: [{ ...NODES[1], x: 999 }, NODES[0]],
      edges: [{ source: 'n_b', target: 'n_a' }],
    })!;
    expect(updated.name).toBe('B');
    expect(updated.enabled).toBe(1);
    expect(updated.cron_expr).toBe('0 8 * * *');

    const nodes = repo.listNodes(job.id);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].seq).toBe(0);
    expect(nodes[0].node_key).toBe('n_b');
    expect(nodes[0].pos_x).toBe(999);
    expect(repo.listEdges(job.id).map((e) => `${e.source_key}→${e.target_key}`)).toEqual(['n_b→n_a']);
  });

  it('listEnabledScheduled 只返回 enabled=1 且 cron_expr 非空', () => {
    const repo = jobsRepo(db);
    repo.create({ ...BASE, ownerId, name: '关', enabled: false, freqType: 'daily', cronExpr: '0 8 * * *', nodes: NODES, edges: EDGES });
    repo.create({ ...BASE, ownerId, name: '开但无cron', enabled: true, nodes: NODES, edges: EDGES });
    const on = repo.create({ ...BASE, ownerId, name: '开且有cron', enabled: true, freqType: 'daily', cronExpr: '0 8 * * *', nodes: NODES, edges: EDGES });
    expect(repo.listEnabledScheduled().map((j) => j.id)).toEqual([on.id]);
  });

  it('remove 级联删除节点与边；listForOwner/listAll', () => {
    const repo = jobsRepo(db);
    const j1 = repo.create({ ...BASE, ownerId, name: 'j1', enabled: false, nodes: NODES, edges: EDGES });
    repo.create({ ...BASE, ownerId, name: 'j2', enabled: false, nodes: NODES, edges: EDGES });
    expect(repo.listForOwner(ownerId)).toHaveLength(2);
    expect(repo.listAll()).toHaveLength(2);
    expect(repo.remove(j1.id)).toBe(true);
    expect(repo.findById(j1.id)).toBeNull();
    expect(repo.listNodes(j1.id)).toHaveLength(0);
    expect(repo.listEdges(j1.id)).toHaveLength(0);
  });
});

describe('jobRunsRepo / jobStepRunsRepo', () => {
  it('run 生命周期、快照回读、节点运行记录与 markSkipped', () => {
    const jobs = jobsRepo(db);
    const runs = jobRunsRepo(db);
    const stepRuns = jobStepRunsRepo(db);
    const job = jobs.create({ ...BASE, ownerId, name: 'j', enabled: false, nodes: NODES, edges: EDGES });
    const snapshot = {
      version: 1 as const,
      nodes: NODES.map((n, i) => ({
        key: n.key, seq: i, type: n.type, name: n.name, onFailure: n.onFailure,
        mode: n.mode, x: n.x, y: n.y, config: JSON.parse(n.config) as Record<string, unknown>,
      })),
      edges: EDGES,
    };

    const jobRun = runs.create({
      jobId: job.id, triggerType: 'manual', triggeredBy: ownerId, graphSnapshot: JSON.stringify(snapshot),
    });
    expect(jobRun.status).toBe('queued');
    expect(JSON.parse(runs.findById(jobRun.id)!.graph_snapshot!)).toEqual(snapshot);

    stepRuns.createBatch(jobRun.id, jobs.listNodes(job.id).map((n) => ({
      stepId: null,
      nodeKey: n.node_key!,
      seq: n.seq,
      type: n.type,
      name: n.name,
      config: n.config,
      onFailure: n.on_failure,
    })));
    const batch = stepRuns.listByJobRun(jobRun.id);
    expect(batch).toHaveLength(2);
    expect(batch.every((s) => s.status === 'pending')).toBe(true);
    expect(batch[0].node_key).toBe('n_a');
    expect(batch[0].config).toBe(NODES[0].config);
    expect(batch[0].on_failure).toBe('abort');

    stepRuns.markRunning(batch[0].id, 1);
    stepRuns.finish(batch[0].id, { status: 'error', finishedAt: 2, durationMs: 1, error: 'boom' });
    expect(stepRuns.findById(batch[0].id)!.status).toBe('error');

    stepRuns.markSkipped(jobRun.id, ['n_a', 'n_b'], 'skipped');
    expect(stepRuns.findById(batch[0].id)!.status).toBe('error'); // 非 pending 不受影响
    expect(stepRuns.findById(batch[1].id)!.status).toBe('skipped');
    expect(stepRuns.findByNodeKey(jobRun.id, 'n_b')!.status).toBe('skipped');

    runs.markRunning(jobRun.id, 3);
    runs.finish(jobRun.id, { status: 'error', finishedAt: 5, durationMs: 2, error: 'boom' });
    expect(runs.findById(jobRun.id)!.status).toBe('error');
    expect(runs.countByJob(job.id)).toBe(1);
    expect(runs.listByJob(job.id, { limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('markSkipped 支持 canceled，且只作用于 pending 记录', () => {
    const jobs = jobsRepo(db);
    const runs = jobRunsRepo(db);
    const stepRuns = jobStepRunsRepo(db);
    const job = jobs.create({ ...BASE, ownerId, name: 'j', enabled: false, nodes: NODES, edges: EDGES });
    const jobRun = runs.create({ jobId: job.id, triggerType: 'manual', triggeredBy: null });
    stepRuns.createBatch(jobRun.id, [{ stepId: null, nodeKey: 'n_a', seq: 0, type: 'workflow', name: '日结', config: '{}', onFailure: 'abort' }]);
    stepRuns.markSkipped(jobRun.id, ['n_a'], 'canceled');
    expect(stepRuns.findByNodeKey(jobRun.id, 'n_a')!.status).toBe('canceled');
    // 幂等：再次标记不会改动终态
    stepRuns.markSkipped(jobRun.id, ['n_a'], 'skipped');
    expect(stepRuns.findByNodeKey(jobRun.id, 'n_a')!.status).toBe('canceled');
  });
});
