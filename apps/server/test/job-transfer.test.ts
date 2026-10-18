import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import { connectionsRepo } from '../src/modules/connections/repo.js';
import { migrate } from '../src/db/migrate.js';
import type { JobService } from '../src/modules/jobs/service.js';
import type { Recorder } from '../src/modules/runs/recorder.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';
import { buildServer } from '../src/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-job-transfer-'));
const resourceDir = mkdtempSync(join(tmpdir(), 'hs-job-transfer-res-'));
writeFileSync(join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n', 'utf-8');
const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
  HUSTSERVER_RESOURCE_DIR: resourceDir,
});

const CONN_NAME = 'Alice 连接';
const WF_NAME = 'Alice 工作流';

let app: FastifyInstance;
let db: Database.Database;
let aliceId: string;
let aliceCookie: string;
let bobCookie: string;
let viewerCookie: string;
let aliceConnId: string;
let aliceWfId: string;
const triggerJob = vi.fn(() => ({ id: 'jr-test' }));

/** 登录并返回会话 cookie */
async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

/** 走接口造一个 Job，返回详情体 */
async function createJob(cookie: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/jobs', headers: { cookie }, payload });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    id: string;
    name: string;
    description: string | null;
    schedule: { enabled: boolean; freqType: string | null; cronExpr: string | null; timezone: string };
    steps: Array<{ type: string; name: string; onFailure: string; config: Record<string, unknown> }>;
  };
}

/** 导出一个 Job，断言 200 并返回导出文件对象 */
async function exportJob(cookie: string, id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}/export`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    kind: string;
    version: number;
    exportedAt: number;
    job: {
      name: string;
      description: string | null;
      schedule: { enabled: boolean; freqType: string | null; cronExpr: string | null; timezone: string };
      steps: Array<{
        type: string;
        name: string;
        onFailure: string;
        config: Record<string, unknown>;
        refs?: { connectionName?: string; workflowName?: string };
      }>;
    };
  };
}

/** 组装一个最小的合法导出文件，便于针对导入做定向用例 */
function jobFile(name: string, steps: unknown[], schedule?: Record<string, unknown>) {
  return {
    kind: 'hustserver.job',
    version: 1,
    exportedAt: Date.now(),
    job: {
      name,
      description: null,
      schedule: schedule ?? { enabled: false, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' },
      steps,
    },
  };
}

function importJob(cookie: string, payload: Record<string, unknown> | unknown[] | string) {
  return app.inject({ method: 'POST', url: '/api/jobs/import', headers: { cookie }, payload });
}

/** 读取 Job 详情 */
async function getJob(cookie: string, id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
  return res;
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  await users.create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  const alice = await users.create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  aliceId = alice.id;
  await users.create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['workflow_author'] });
  await users.create({ username: 'viewer', passwordHash: await hashPassword('viewer123'), roles: ['dashboard_viewer'] });

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
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');
  viewerCookie = await login('viewer', 'viewer123');

  aliceConnId = connectionsRepo(db).create({
    ownerId: aliceId, name: CONN_NAME, type: 'sqlserver',
    configEncrypted: encryptConfig({ server: '127.0.0.1', database: 'd', user: 'sa', password: 'p' }, cfg.encryptionKey),
    shared: false,
  }).id;
  aliceWfId = workflowsRepo(db).create({ ownerId: alice.id, name: WF_NAME, payload: '{}' }).id;
  triggerJob.mockClear();
});

afterEach(async () => {
  await app.close();
});

describe('Job 导出', () => {
  it('返回 kind/version/exportedAt/job，名称、描述、调度、步骤与原 Job 一致', async () => {
    const job = await createJob(aliceCookie, {
      name: '日结', description: '每日结算',
      steps: [
        { type: 'workflow', name: '跑流', workflowId: aliceWfId, onFailure: 'continue' },
        { type: 'sql', name: '取数', connectionId: aliceConnId, sql: 'SELECT 1', onFailure: 'abort' },
      ],
      schedule: { enabled: true, freqType: 'daily', time: '08:00' },
    });

    const file = await exportJob(aliceCookie, job.id);

    expect(file.kind).toBe('hustserver.job');
    expect(file.version).toBe(1);
    expect(typeof file.exportedAt).toBe('number');
    expect(file.job.name).toBe('日结');
    expect(file.job.description).toBe('每日结算');
    expect(file.job.schedule).toEqual({
      enabled: true, freqType: 'daily', cronExpr: '0 8 * * *', timezone: 'Asia/Shanghai',
    });
    expect(file.job.steps).toHaveLength(2);

    // 与原 Job 的读取结果一致
    const detail = (await getJob(aliceCookie, job.id)).json();
    expect(detail.name).toBe(file.job.name);
    expect(detail.description).toBe(file.job.description);
    expect(detail.schedule).toEqual(file.job.schedule);
    expect(detail.steps.map((s: { type: string; name: string; onFailure: string; config: unknown }) => ({
      type: s.type, name: s.name, onFailure: s.onFailure, config: s.config,
    }))).toEqual(file.job.steps.map((s) => ({
      type: s.type, name: s.name, onFailure: s.onFailure, config: s.config,
    })));
  });

  it('把连接名/工作流名写进 refs，config 保留原始存储字段', async () => {
    const job = await createJob(aliceCookie, {
      name: '带引用',
      steps: [
        { type: 'sql', name: '取数', connectionId: aliceConnId, sql: 'SELECT 42', onFailure: 'abort' },
        { type: 'workflow', name: '跑流', workflowId: aliceWfId, onFailure: 'abort' },
      ],
    });

    const file = await exportJob(aliceCookie, job.id);
    const sqlStep = file.job.steps.find((s) => s.type === 'sql')!;
    const wfStep = file.job.steps.find((s) => s.type === 'workflow')!;

    expect(sqlStep.refs).toEqual({ connectionName: CONN_NAME });
    expect(sqlStep.config).toEqual({ connectionId: aliceConnId, sql: 'SELECT 42' });

    expect(wfStep.refs).toEqual({ workflowName: WF_NAME });
    expect(wfStep.config).toEqual({ workflowId: aliceWfId });
  });

  it('鉴权：不存在 404、他人 Job 403、无 job 能力 403、未登录 401', async () => {
    const job = await createJob(aliceCookie, {
      name: '私有', steps: [{ type: 'workflow', name: 's', workflowId: aliceWfId, onFailure: 'abort' }],
    });

    const missing = await app.inject({ method: 'GET', url: '/api/jobs/no-such-id/export', headers: { cookie: aliceCookie } });
    expect(missing.statusCode).toBe(404);

    const other = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/export`, headers: { cookie: bobCookie } });
    expect(other.statusCode).toBe(403);

    const noCap = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/export`, headers: { cookie: viewerCookie } });
    expect(noCap.statusCode).toBe(403);

    const anon = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/export` });
    expect(anon.statusCode).toBe(401);
  });
});

describe('Job 导入', () => {
  it('把导出对象原样 POST 回去：201、name/warnings 正确，步骤与调度与导出前一致', async () => {
    const job = await createJob(aliceCookie, {
      name: '往返', description: '往返描述',
      steps: [
        { type: 'workflow', name: '跑流', workflowId: aliceWfId, onFailure: 'continue' },
        { type: 'sql', name: '取数', connectionId: aliceConnId, sql: 'SELECT 7', onFailure: 'abort' },
      ],
      schedule: { enabled: true, freqType: 'daily', time: '09:30' },
    });
    const file = await exportJob(aliceCookie, job.id);
    // 先删除原 Job，避免同名后缀干扰，保证 warnings 为空
    await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: { cookie: aliceCookie } });

    const res = await importJob(aliceCookie, file);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; warnings: string[] };
    expect(body.name).toBe('往返');
    expect(body.warnings).toEqual([]);
    expect(body.id).toBeTruthy();
    expect(body.id).not.toBe(job.id);

    const detail = (await getJob(aliceCookie, body.id)).json();
    expect(detail.name).toBe(file.job.name);
    expect(detail.description).toBe(file.job.description);
    expect(detail.schedule).toEqual(file.job.schedule);
    expect(detail.steps.map((s: { type: string; name: string; onFailure: string; config: unknown }) => ({
      type: s.type, name: s.name, onFailure: s.onFailure, config: s.config,
    }))).toEqual(file.job.steps.map((s) => ({
      type: s.type, name: s.name, onFailure: s.onFailure, config: s.config,
    })));
  });

  it('同名自动加后缀：(2) 再到 (3)，并带提示 warning', async () => {
    const job = await createJob(aliceCookie, {
      name: '重名', steps: [{ type: 'sql', name: 's', connectionId: aliceConnId, sql: 'SELECT 1', onFailure: 'abort' }],
    });
    const file = await exportJob(aliceCookie, job.id);

    const first = await importJob(aliceCookie, file);
    expect(first.statusCode).toBe(201);
    expect(first.json().name).toBe('重名 (2)');
    expect(first.json().warnings).toContain('已存在同名 Job，本次导入为「重名 (2)」');

    const second = await importJob(aliceCookie, file);
    expect(second.statusCode).toBe(201);
    expect(second.json().name).toBe('重名 (3)');
    expect(second.json().warnings).toContain('已存在同名 Job，本次导入为「重名 (3)」');
  });

  it('连接按名称匹配：原 id 已失效但 refs 名称命中，替换为真实连接 id 且无连接 warning', async () => {
    const job = await createJob(aliceCookie, {
      name: '连接重匹配', steps: [{ type: 'sql', name: '取数', connectionId: aliceConnId, sql: 'SELECT 1', onFailure: 'abort' }],
    });
    const file = await exportJob(aliceCookie, job.id);
    // 让原 id 失效（模拟跨环境），但保留 refs 里的连接名
    (file.job.steps[0].config as Record<string, unknown>).connectionId = 'gone-conn-id';
    await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: { cookie: aliceCookie } });

    const res = await importJob(aliceCookie, file);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; warnings: string[] };
    expect(body.warnings.some((w) => w.includes('连接'))).toBe(false);

    const detail = (await getJob(aliceCookie, body.id)).json();
    expect(detail.steps[0].config.connectionId).toBe(aliceConnId);
  });

  it('连接匹配不到：connectionId 清空为 ""，且有连接提示 warning', async () => {
    const file = jobFile('缺连接', [
      { type: 'sql', name: '取数', onFailure: 'abort', config: { connectionId: 'ghost', sql: 'SELECT 1' }, refs: { connectionName: '不存在的连接' } },
    ]);

    const res = await importJob(aliceCookie, file);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; warnings: string[] };
    expect(body.warnings.some((w) => w.includes('连接「不存在的连接」'))).toBe(true);

    const detail = (await getJob(aliceCookie, body.id)).json();
    expect(detail.steps[0].config.connectionId).toBe('');
    expect(detail.steps[0].config.sql).toBe('SELECT 1');
  });

  it('工作流按名称匹配成功则替换 id；匹配不到则清空为 "" 并有 warning', async () => {
    // 命中
    const hit = jobFile('工作流命中', [
      { type: 'workflow', name: '跑流', onFailure: 'abort', config: { workflowId: 'gone-wf' }, refs: { workflowName: WF_NAME } },
    ]);
    const hitRes = await importJob(aliceCookie, hit);
    expect(hitRes.statusCode).toBe(201);
    const hitBody = hitRes.json() as { id: string; warnings: string[] };
    expect(hitBody.warnings.some((w) => w.includes('工作流'))).toBe(false);
    const hitDetail = (await getJob(aliceCookie, hitBody.id)).json();
    expect(hitDetail.steps[0].config.workflowId).toBe(aliceWfId);

    // 未命中
    const miss = jobFile('工作流未命中', [
      { type: 'workflow', name: '跑流', onFailure: 'abort', config: { workflowId: 'gone-wf' }, refs: { workflowName: '不存在的流' } },
    ]);
    const missRes = await importJob(aliceCookie, miss);
    expect(missRes.statusCode).toBe(201);
    const missBody = missRes.json() as { id: string; warnings: string[] };
    expect(missBody.warnings.some((w) => w.includes('工作流「不存在的流」'))).toBe(true);
    const missDetail = (await getJob(aliceCookie, missBody.id)).json();
    expect(missDetail.steps[0].config.workflowId).toBe('');
  });

  it('文件级非法：kind/version/非对象/steps 为空/名称为空 均 400', async () => {
    const base = jobFile('x', [
      { type: 'sql', name: 's', onFailure: 'abort', config: { connectionId: '', sql: 'SELECT 1' } },
    ]);

    const badKind = await importJob(aliceCookie, { ...base, kind: 'other.kind' });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error).toContain('不是 Job 导出文件');

    const badVersion = await importJob(aliceCookie, { ...base, version: 2 });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().error).toContain('不支持的文件版本');

    const emptySteps = await importJob(aliceCookie, jobFile('x', []));
    expect(emptySteps.statusCode).toBe(400);
    expect(emptySteps.json().error).toContain('steps');

    const emptyName = await importJob(aliceCookie, jobFile('', [
      { type: 'sql', name: 's', onFailure: 'abort', config: { connectionId: '', sql: 'SELECT 1' } },
    ]));
    expect(emptyName.statusCode).toBe(400);
    expect(emptyName.json().error).toContain('名称');

    const arrayBody = await importJob(aliceCookie, [1, 2, 3]);
    expect(arrayBody.statusCode).toBe(400);

    const stringBody = await app.inject({
      method: 'POST', url: '/api/jobs/import',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      payload: '"not an object"',
    });
    expect(stringBody.statusCode).toBe(400);
  });

  it('步骤级非法：SQL 为空 / 模型名非法 / load_model 来源无效 均 400', async () => {
    const emptySql = await importJob(aliceCookie, jobFile('空SQL', [
      { type: 'sql', name: 's', onFailure: 'abort', config: { connectionId: '', sql: '' } },
    ]));
    expect(emptySql.statusCode).toBe(400);
    expect(emptySql.json().error).toContain('SQL 不能为空');

    const badModel = await importJob(aliceCookie, jobFile('坏模型名', [
      { type: 'load_model', name: 's', onFailure: 'abort', config: { source: 'file', modelName: '1abc', resourcePath: 'sales.csv' } },
    ]));
    expect(badModel.statusCode).toBe(400);
    expect(badModel.json().error).toContain('模型名不合法');

    const badSource = await importJob(aliceCookie, jobFile('坏来源', [
      { type: 'load_model', name: 's', onFailure: 'abort', config: { source: 'ftp', modelName: 'ok_model' } },
    ]));
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json().error).toContain('数据来源无效');
  });

  it('需要 job 能力：无能力用户 403、未登录 401', async () => {
    const file = jobFile('cap', [
      { type: 'sql', name: 's', onFailure: 'abort', config: { connectionId: '', sql: 'SELECT 1' } },
    ]);

    const forbidden = await importJob(viewerCookie, file);
    expect(forbidden.statusCode).toBe(403);

    const anon = await app.inject({ method: 'POST', url: '/api/jobs/import', payload: file });
    expect(anon.statusCode).toBe(401);
  });
});
