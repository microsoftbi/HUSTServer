import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let store: ModelStore;
let authorCookie: string;
let wfCookie: string;
let viewerCookie: string;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-route-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-route-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n3,30\n', 'utf-8');

  const db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  await users.create({ username: 'author', passwordHash, roles: ['dashboard_author'] });
  await users.create({ username: 'wf', passwordHash, roles: ['workflow_author'] });
  await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  store = createModelStore({ db, config: cfg });
  await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);

  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  authorCookie = await login('author');
  wfCookie = await login('wf');
  viewerCookie = await login('viewer');
});

afterEach(() => {
  store.close();
});

describe('GET /api/models', () => {
  it('未登录 401；viewer/author 可读，wf（无 dashboard.view）403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401);

    const viewer = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: viewerCookie } });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().items[0]).toMatchObject({ name: 'sales_model', sourceKind: 'csv', rowCount: 3 });

    const author = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: authorCookie } });
    expect(author.statusCode).toBe(200);

    const wf = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: wfCookie } });
    expect(wf.statusCode).toBe(403);
  });
});

describe('POST /api/models/query', () => {
  it('返回 { columns, rows, truncated }', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/models/query', headers: { cookie: authorCookie },
      payload: { name: 'sales_model' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      columns: [{ name: 'id', type: 'number' }, { name: 'amount', type: 'number' }],
      rows: [[1, 10], [2, 20], [3, 30]],
      truncated: false,
    });
  });

  it('缺 name 400 / 模型不存在 404 / 无 dashboard.view 403', async () => {
    const noName = await app.inject({ method: 'POST', url: '/api/models/query', headers: { cookie: authorCookie }, payload: {} });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toBe('缺少模型名');

    const missing = await app.inject({ method: 'POST', url: '/api/models/query', headers: { cookie: authorCookie }, payload: { name: 'nope' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('模型不存在');

    const wf = await app.inject({ method: 'POST', url: '/api/models/query', headers: { cookie: wfCookie }, payload: { name: 'sales_model' } });
    expect(wf.statusCode).toBe(403);
  });
});

describe('PATCH /api/models/:name', () => {
  it('wf 可重命名；author（无 job）403；重名 409；非法名 400；不存在 404', async () => {
    const noCap = await app.inject({ method: 'PATCH', url: '/api/models/sales_model', headers: { cookie: authorCookie }, payload: { newName: 'x' } });
    expect(noCap.statusCode).toBe(403);

    const ok = await app.inject({ method: 'PATCH', url: '/api/models/sales_model', headers: { cookie: wfCookie }, payload: { newName: 'sales_model_v2' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: authorCookie } });
    expect(list.json().items.map((m: { name: string }) => m.name)).toEqual(['sales_model_v2']);

    const conflict = await app.inject({ method: 'PATCH', url: '/api/models/sales_model_v2', headers: { cookie: wfCookie }, payload: { newName: 'sales_model_v2' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('模型名已存在');

    const bad = await app.inject({ method: 'PATCH', url: '/api/models/sales_model_v2', headers: { cookie: wfCookie }, payload: { newName: '1bad' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('模型名不合法');

    const missing = await app.inject({ method: 'PATCH', url: '/api/models/nope', headers: { cookie: wfCookie }, payload: { newName: 'ok_name' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('DELETE /api/models/:name', () => {
  it('author（无 job）403；wf 可删除；不存在 404', async () => {
    const noCap = await app.inject({ method: 'DELETE', url: '/api/models/sales_model', headers: { cookie: authorCookie } });
    expect(noCap.statusCode).toBe(403);

    const missing = await app.inject({ method: 'DELETE', url: '/api/models/nope', headers: { cookie: wfCookie } });
    expect(missing.statusCode).toBe(404);

    const ok = await app.inject({ method: 'DELETE', url: '/api/models/sales_model', headers: { cookie: wfCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: authorCookie } });
    expect(list.json().items).toHaveLength(0);
  });
});
