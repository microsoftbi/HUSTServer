import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import { connectionsRepo } from '../src/modules/connections/repo.js';
import { migrate } from '../src/db/migrate.js';
import { jobRunsRepo, type JobRunRow } from '../src/modules/jobs/repo.js';
import type { JobService } from '../src/modules/jobs/service.js';
import type { Recorder } from '../src/modules/runs/recorder.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-job-routes-'));
const resourceDir = mkdtempSync(join(tmpdir(), 'hs-job-routes-res-'));
writeFileSync(join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n', 'utf-8');
const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
  HUSTSERVER_RESOURCE_DIR: resourceDir,
});

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let workflowId: string;
let sharedConnId: string;
const triggerJob = vi.fn(() => ({ id: 'jr-test' } as unknown as JobRunRow));
const cancelJob = vi.fn(() => true);

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  const alice = await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['workflow_author'] });

  const recorder = {} as Recorder;
  const runService = { trigger: vi.fn(), whenIdle: async () => {} } as unknown as RunService;
  const scheduler = { sync: vi.fn(), start() {}, stop() {}, registeredIds: () => [] } as unknown as Scheduler;
  const jobScheduler = { sync: vi.fn(), start() {}, stop() {}, registeredIds: () => [] } as unknown as Scheduler;
  const jobService = { trigger: triggerJob, cancel: cancelJob, whenIdle: async () => {} } as unknown as JobService;

  app = await buildServer({
    db, config: cfg, logger: false,
    overrides: { recorder, runService, scheduler, jobService, jobScheduler },
  });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');

  const wf = await app.inject({
    method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie },
    payload: { workflow: { id: 'w', name: '样例', createdAt: 0, updatedAt: 0, nodes: [], edges: [] }, mappings: [] },
  });
  workflowId = wf.json().id;
  sharedConnId = connectionsRepo(db).create({
    ownerId: alice.id, name: '共享库', type: 'sqlserver',
    configEncrypted: encryptConfig({ server: '127.0.0.1', database: 'd', user: 'sa', password: 'p' }, cfg.encryptionKey.toString('hex')),
    shared: true,
  }).id;
  triggerJob.mockClear();
  cancelJob.mockReset();
  cancelJob.mockReturnValue(true);
});

describe('job routes', () => {
  it('POST 创建 Job 并 resync；GET 列表含 stepCount/nextRunAt/lastRun', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: {
        name: '日结', description: 'd',
        steps: [{ type: 'workflow', name: 's1', workflowId, onFailure: 'abort' }],
        schedule: { enabled: true, freqType: 'daily', time: '08:00' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule).toMatchObject({ enabled: true, freqType: 'daily', cronExpr: '0 8 * * *' });
    expect(res.json().nodes[0].config).toEqual({ workflowId });

    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    expect(list.statusCode).toBe(200);
    const item = list.json().items[0];
    expect(item).toMatchObject({ name: '日结', nodeCount: 1, edgeCount: 0, enabled: 1 });
    expect(typeof item.nextRunAt).toBe('number');
    expect(item.lastRun).toBeNull();
  });

  it('GET 列表的 lastRun 带触发方式与耗时（Job 日志页用）', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: {
        name: '带日志',
        steps: [{ type: 'workflow', name: 's1', workflowId, onFailure: 'abort' }],
        schedule: { enabled: false },
      },
    });
    const jobId = created.json().id as string;
    db.prepare(
      `INSERT INTO job_runs (id, job_id, trigger_type, triggered_by, status, started_at, finished_at, duration_ms, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('jr-1', jobId, 'schedule', null, 'success', 1000, 4200, 3200, null, 5000);

    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    const item = list.json().items.find((j: { id: string }) => j.id === jobId);
    expect(item.lastRun).toEqual({
      id: 'jr-1',
      status: 'success',
      created_at: 5000,
      trigger_type: 'schedule',
      duration_ms: 3200,
    });
  });

  it('鉴权与基础校验：401 / 403 / 空 name / 空 steps / 非法 schedule', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(anon.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'j', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id;

    const forbidden = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie: bobCookie } });
    expect(forbidden.statusCode).toBe(403);

    const noName = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: '', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    expect(noName.statusCode).toBe(400);

    const noSteps = await app.inject({ method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie }, payload: { name: 'x', steps: [] } });
    expect(noSteps.statusCode).toBe(400);

    const badSched = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }], schedule: { enabled: true, freqType: 'daily', time: '25:00' } },
    });
    expect(badSched.statusCode).toBe(400);
  });

  it('引用不可见工作流/连接返回 400；共享连接可用', async () => {
    // bob 引用 alice 的私有工作流（bob 建的 wf 才可见，这里直接用 alice 的 wfId）
    const badWf = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: { name: 'x', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    expect(badWf.statusCode).toBe(400);

    const noSql = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'sql', name: 's', connectionId: sharedConnId, sql: '', onFailure: 'abort' }] },
    });
    expect(noSql.statusCode).toBe(400);

    const okSql = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: { name: 'bob用共享连接', steps: [{ type: 'sql', name: 's', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'continue' }] },
    });
    expect(okSql.statusCode).toBe(201);
    expect(okSql.json().nodes[0].onFailure).toBe('continue');
  });

  it('load_model 步骤：file 源校验与成功创建', async () => {
    const badName = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'file', modelName: '1bad', resourcePath: 'sales.csv', onFailure: 'abort' }] },
    });
    expect(badName.statusCode).toBe(400);
    expect(badName.json().error).toBe('模型名不合法');

    const missingFile = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'file', modelName: 'sales_model', resourcePath: 'nope.csv', onFailure: 'abort' }] },
    });
    expect(missingFile.statusCode).toBe(400);
    expect(missingFile.json().error).toBe('资源文件不可用');

    const ok = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: '加载模型', steps: [{ type: 'load_model', name: '加载', source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv', onFailure: 'continue' }] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().nodes[0]).toMatchObject({
      type: 'load_model', name: '加载', onFailure: 'continue',
      config: { source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' },
    });
  });

  it('load_model 步骤：sqlserver 源校验与成功创建', async () => {
    const noTarget = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'sqlserver', modelName: 'm', connectionId: sharedConnId, onFailure: 'abort' }] },
    });
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json().error).toBe('需要指定表或查询');

    const badSource = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'ftp', modelName: 'm', onFailure: 'abort' }] },
    });
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json().error).toBe('步骤来源无效');

    const ok = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: { name: 'bob加载', steps: [{ type: 'load_model', name: 's', source: 'sqlserver', modelName: 'sales_model', connectionId: sharedConnId, object: 'dbo.sales', onFailure: 'abort' }] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().nodes[0].config).toEqual({
      source: 'sqlserver', modelName: 'sales_model', connectionId: sharedConnId, object: 'dbo.sales',
    });
  });

  it('PUT 整体覆盖；DELETE 后列表为空', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'A', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const jobId = created.json().id;

    const put = await app.inject({
      method: 'PUT', url: `/api/jobs/${jobId}`, headers: { cookie: aliceCookie },
      payload: {
        name: 'B',
        steps: [
          { type: 'workflow', name: 's1', workflowId, onFailure: 'continue' },
          { type: 'sql', name: 's2', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'abort' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().name).toBe('B');
    expect(put.json().nodes).toHaveLength(2);
    expect(put.json().edges).toHaveLength(1);
    expect(put.json().schedule.enabled).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    expect(list.json().items).toHaveLength(0);
  });

  it('手动运行返回 202 并调用 jobService.trigger；运行历史与详情可查', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'J', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const jobId = created.json().id;

    const started = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/runs`, headers: { cookie: aliceCookie } });
    expect(started.statusCode).toBe(202);
    expect(triggerJob).toHaveBeenCalledWith(jobId, { triggerType: 'manual', triggeredBy: expect.any(String) });
    const jobRunId = started.json().jobRunId;

    const history = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/runs?limit=10`, headers: { cookie: aliceCookie } });
    expect(history.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/job-runs/${jobRunId}`, headers: { cookie: aliceCookie } });
    // jobService 为桩，未真实创建 job_run —— 详情应 404
    expect(detail.statusCode).toBe(404);
  });

  it('画布图校验：环形/重复 key/悬空边/自环/重复边/非法模式/非法坐标 均 400', async () => {
    const create = (nodes: unknown[], edges?: unknown[]) => app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: '图', nodes, edges },
    });
    const node = (key: string, extra: Record<string, unknown> = {}) => ({
      key, type: 'sql', name: key, connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'abort', ...extra,
    });

    const cycle = await create([node('a'), node('b')], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]);
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toContain('存在循环依赖');

    const dupKey = await create([node('a'), node('a')]);
    expect(dupKey.statusCode).toBe(400);
    expect(dupKey.json().error).toContain('节点标识不合法或重复');

    const badKey = await create([node('a b')]);
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json().error).toContain('节点标识不合法或重复');

    const dangling = await create([node('a')], [{ source: 'a', target: 'ghost' }]);
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().error).toContain('连线引用了不存在的节点');

    const selfLoop = await create([node('a')], [{ source: 'a', target: 'a' }]);
    expect(selfLoop.statusCode).toBe(400);
    expect(selfLoop.json().error).toContain('不能连接到自身');

    const dupEdge = await create([node('a'), node('b')], [
      { source: 'a', target: 'b' }, { source: 'a', target: 'b' },
    ]);
    expect(dupEdge.statusCode).toBe(400);
    expect(dupEdge.json().error).toContain('存在重复连线');

    const badMode = await create([node('a', { mode: 'paused' })]);
    expect(badMode.statusCode).toBe(400);
    expect(badMode.json().error).toContain('节点运行模式不合法');

    const badCoord = await create([node('a', { x: 'left' })]);
    expect(badCoord.statusCode).toBe(400);
    expect(badCoord.json().error).toContain('节点坐标不合法');
  });

  it('画布图正常保存：DAG、模式与坐标原样回读；全部禁用只影响运行不阻止保存', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: {
        name: 'DAG',
        nodes: [
          { key: 'a', type: 'sql', name: 'A', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'abort', mode: 'disable', x: 10, y: 20 },
          { key: 'b', type: 'sql', name: 'B', connectionId: sharedConnId, sql: 'SELECT 2', onFailure: 'continue', mode: 'skip', x: 300, y: 40 },
          { key: 'c', type: 'workflow', name: 'C', workflowId, onFailure: 'abort', mode: 'run', x: 560, y: 60 },
        ],
        edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.nodes.map((n: { key: string }) => n.key)).toEqual(['a', 'b', 'c']);
    expect(body.nodes.map((n: { mode: string }) => n.mode)).toEqual(['disable', 'skip', 'run']);
    expect(body.nodes.map((n: { x: number }) => n.x)).toEqual([10, 300, 560]);
    expect(body.edges).toEqual([{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]);

    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    expect(list.json().items[0]).toMatchObject({ nodeCount: 3, edgeCount: 2 });

    // 全部禁用仍可保存（运行时会因「没有可执行的节点」而被拒，属执行器职责）
    const allDisabled = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: {
        name: '全禁用',
        nodes: [
          { key: 'a', type: 'sql', name: 'A', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'abort', mode: 'disable' },
          { key: 'b', type: 'sql', name: 'B', connectionId: sharedConnId, sql: 'SELECT 2', onFailure: 'abort', mode: 'run' },
        ],
        edges: [{ source: 'a', target: 'b' }],
      },
    });
    expect(allDisabled.statusCode).toBe(201);
  });

  it('取消运行：可取消返回 ok 并调用 jobService.cancel；不可取消 409；他人 403', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'K', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const jobId = created.json().id as string;
    db.prepare(
      `INSERT INTO job_runs (id, job_id, trigger_type, triggered_by, status, started_at, finished_at, duration_ms, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('jr-cancel', jobId, 'manual', null, 'running', 1000, null, null, null, 5000);

    const other = await app.inject({ method: 'POST', url: '/api/job-runs/jr-cancel/cancel', headers: { cookie: bobCookie } });
    expect(other.statusCode).toBe(403);

    const ok = await app.inject({ method: 'POST', url: '/api/job-runs/jr-cancel/cancel', headers: { cookie: aliceCookie } });
    expect(ok.statusCode).toBe(200);
    expect(cancelJob).toHaveBeenCalledWith('jr-cancel');

    cancelJob.mockReturnValue(false);
    const conflict = await app.inject({ method: 'POST', url: '/api/job-runs/jr-cancel/cancel', headers: { cookie: aliceCookie } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('JOB_RUN_NOT_CANCELABLE');

    const missing = await app.inject({ method: 'POST', url: '/api/job-runs/no-such/cancel', headers: { cookie: aliceCookie } });
    expect(missing.statusCode).toBe(404);
  });

  it('admin 可见全部 Job', async () => {
    await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'alice的', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: adminCookie } });
    expect(list.json().items).toHaveLength(1);
  });

  it('GET /api/job-runs 列出全部运行记录：管理员跨用户可见、普通用户仅自己、支持分页', async () => {
    const aliceJob = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'A', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const bobJob = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: {
        name: 'B',
        nodes: [{ key: 'n1', type: 'sql', name: 'n1', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'abort' }],
      },
    });
    const runs = jobRunsRepo(db);
    runs.create({ jobId: aliceJob.json().id, triggerType: 'manual', triggeredBy: null });
    runs.create({ jobId: bobJob.json().id, triggerType: 'schedule', triggeredBy: null });

    const admin = await app.inject({ method: 'GET', url: '/api/job-runs', headers: { cookie: adminCookie } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().total).toBe(2);
    expect(admin.json().items.map((r: { job_name: string }) => r.job_name).sort()).toEqual(['A', 'B']);

    const alice = await app.inject({ method: 'GET', url: '/api/job-runs', headers: { cookie: aliceCookie } });
    expect(alice.json().total).toBe(1);
    expect(alice.json().items[0].job_name).toBe('A');

    const bob = await app.inject({ method: 'GET', url: '/api/job-runs', headers: { cookie: bobCookie } });
    expect(bob.json().total).toBe(1);
    expect(bob.json().items[0].job_name).toBe('B');

    const paged = await app.inject({
      method: 'GET', url: '/api/job-runs?limit=1&offset=1', headers: { cookie: adminCookie },
    });
    expect(paged.json().total).toBe(2);
    expect(paged.json().items).toHaveLength(1);

    const anonymous = await app.inject({ method: 'GET', url: '/api/job-runs' });
    expect(anonymous.statusCode).toBe(401);
  });
});
