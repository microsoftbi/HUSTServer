import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import type { Recorder } from '../src/modules/runs/recorder.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-sched-routes-'));
const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
});

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let workflowId: string;
const sync = vi.fn();

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['workflow_author'] });

  const recorder = {} as Recorder;
  const runService = { trigger: vi.fn(), whenIdle: async () => {} } as unknown as RunService;
  const scheduler = { sync } as unknown as Scheduler;

  app = await buildServer({
    db,
    config: cfg,
    logger: false,
    overrides: { recorder, runService, scheduler },
  });
  await app.ready();
  sync.mockClear();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');

  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: { cookie: aliceCookie },
    payload: { workflow: { id: 'w', name: '样例', createdAt: 0, updatedAt: 0, nodes: [], edges: [] }, mappings: [] },
  });
  workflowId = created.json().id;
});

describe('schedule routes', () => {
  it('预设 daily 自动生成 cron_expr 并返回 nextRunAt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'daily', time: '09:30' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cron_expr).toBe('30 9 * * *');
    expect(body.timezone).toBe('Asia/Shanghai');
    expect(typeof body.nextRunAt).toBe('number');
    expect(sync).toHaveBeenCalled();

    const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: aliceCookie } });
    expect(list.json().items).toHaveLength(1);
  });

  it('非法预设时间与非法 cron 返回 400', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'daily', time: '25:00' },
    });
    expect(bad.statusCode).toBe(400);

    const badCron = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'cron', cronExpr: 'not a cron' },
    });
    expect(badCron.statusCode).toBe(400);
  });

  it('未登录 401，非属主 403，管理员可读', async () => {
    const anon = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules` });
    expect(anon.statusCode).toBe(401);

    const forbidden = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: bobCookie } });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: adminCookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('PUT 可启停并改表达式，联动 scheduler.reload', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'weekly', time: '08:00', weekday: 1 },
    });
    const id = created.json().id;
    expect(created.json().cron_expr).toBe('0 8 * * 1');
    sync.mockClear();

    const off = await app.inject({
      method: 'PUT',
      url: `/api/schedules/${id}`,
      headers: { cookie: aliceCookie },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(0);
    expect(off.json().cron_expr).toBe('0 8 * * 1');
    expect(sync).toHaveBeenCalledTimes(1);

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/schedules/${id}`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'cron', cronExpr: '0 3 * * *', enabled: true },
    });
    expect(changed.json()).toMatchObject({ enabled: 1, freq_type: 'cron', cron_expr: '0 3 * * *' });
  });

  it('DELETE 删除后列表为空', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'daily', time: '09:00' },
    });
    const id = created.json().id;
    sync.mockClear();

    const del = await app.inject({ method: 'DELETE', url: `/api/schedules/${id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);

    const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: aliceCookie } });
    expect(list.json().items).toHaveLength(0);
  });

  it('对不存在的调度 PUT/DELETE 返回 404', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/schedules/nope', headers: { cookie: aliceCookie }, payload: { enabled: false } });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/schedules/nope', headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(404);
  });
});
