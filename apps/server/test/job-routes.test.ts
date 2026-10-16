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
import type { JobRunRow } from '../src/modules/jobs/repo.js';
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
  const jobService = { trigger: triggerJob, whenIdle: async () => {} } as unknown as JobService;

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
    expect(res.json().steps[0].config).toEqual({ workflowId });

    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    expect(list.statusCode).toBe(200);
    const item = list.json().items[0];
    expect(item).toMatchObject({ name: '日结', stepCount: 1, enabled: 1 });
    expect(typeof item.nextRunAt).toBe('number');
    expect(item.lastRun).toBeNull();
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
    expect(okSql.json().steps[0].onFailure).toBe('continue');
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
    expect(ok.json().steps[0]).toMatchObject({
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
    expect(ok.json().steps[0].config).toEqual({
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
    expect(put.json().steps).toHaveLength(2);
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

  it('admin 可见全部 Job', async () => {
    await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'alice的', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: adminCookie } });
    expect(list.json().items).toHaveLength(1);
  });
});
