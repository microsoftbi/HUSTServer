import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const KEY = 'a'.repeat(64);

let app: FastifyInstance;
let cookieOf: Record<'viewer' | 'dashAuthor' | 'wf', string>;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hust-caps-res-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hust-caps-data-'));

  const db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });
  await users.create({ username: 'dashAuthor', passwordHash, roles: ['dashboard_author'] });
  await users.create({ username: 'wf', passwordHash, roles: ['workflow_author'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: KEY,
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();

  cookieOf = {
    viewer: await login('viewer'),
    dashAuthor: await login('dashAuthor'),
    wf: await login('wf'),
  };
});

describe('resources 读取门禁（resources 或 dashboard.edit）', () => {
  it('wf / dashAuthor 可读，viewer 返回 403', async () => {
    const wf = await app.inject({ method: 'GET', url: '/api/resources', headers: { cookie: cookieOf.wf } });
    expect(wf.statusCode).toBe(200);

    const dash = await app.inject({
      method: 'GET',
      url: '/api/resources',
      headers: { cookie: cookieOf.dashAuthor },
    });
    expect(dash.statusCode).toBe(200);

    const viewer = await app.inject({
      method: 'GET',
      url: '/api/resources',
      headers: { cookie: cookieOf.viewer },
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error).toBe('需要「资源管理」或「仪表板编辑」权限');
  });
});

describe('resources 写入门禁（resources）', () => {
  it('dashAuthor 返回 403，wf 可创建', async () => {
    const dash = await app.inject({
      method: 'POST',
      url: '/api/resources/folders',
      headers: { cookie: cookieOf.dashAuthor },
      payload: { path: '', name: '新目录' },
    });
    expect(dash.statusCode).toBe(403);
    expect(dash.json().error).toBe('需要「资源管理」权限');

    const wf = await app.inject({
      method: 'POST',
      url: '/api/resources/folders',
      headers: { cookie: cookieOf.wf },
      payload: { path: '', name: '新目录' },
    });
    expect(wf.statusCode).toBe(201);
  });
});

describe('schema 门禁', () => {
  it('dashAuthor 调 sqlserver 不被守卫拦截（非 403），viewer 调 csv 返回 403', async () => {
    const sql = await app.inject({
      method: 'POST',
      url: '/api/schema/sqlserver',
      headers: { cookie: cookieOf.dashAuthor },
      payload: {},
    });
    expect(sql.statusCode).not.toBe(403);
    expect(sql.statusCode).toBe(400);
    expect(sql.json().error).toBe('缺少查询语句');

    const csv = await app.inject({
      method: 'POST',
      url: '/api/schema/csv',
      headers: { cookie: cookieOf.viewer },
      payload: {},
    });
    expect(csv.statusCode).toBe(403);
    expect(csv.json().error).toBe('需要「资源管理」权限');
  });
});

describe('data 门禁（connection.use）', () => {
  it('dashAuthor 调 query 不被守卫拦截（非 403），viewer 返回 403', async () => {
    const dash = await app.inject({
      method: 'POST',
      url: '/api/data/query',
      headers: { cookie: cookieOf.dashAuthor },
      payload: {},
    });
    expect(dash.statusCode).not.toBe(403);
    expect(dash.statusCode).toBe(400);
    expect(dash.json().error).toBe('缺少连接 ID');

    const viewer = await app.inject({
      method: 'POST',
      url: '/api/data/query',
      headers: { cookie: cookieOf.viewer },
      payload: {},
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error).toBe('需要「连接使用」权限');
  });
});
