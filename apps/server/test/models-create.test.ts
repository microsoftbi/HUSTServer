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
let resourceDir: string;
let authorCookie: string;
let viewerCookie: string;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-create-data-'));
  resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-create-res-'));
  fs.mkdirSync(path.join(resourceDir, '数据'));
  fs.writeFileSync(path.join(resourceDir, '数据', 'sales.csv'), 'id,amount\n1,10\n2,20\n', 'utf-8');

  const db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  // 直接建模型要求 job 能力
  await users.create({ username: 'author', passwordHash, roles: ['workflow_author'] });
  await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  store = createModelStore({ db, config: cfg });

  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  authorCookie = await login('author');
  viewerCookie = await login('viewer');
});

afterEach(() => {
  store.close();
});

async function create(payload: unknown, cookie = authorCookie) {
  return app.inject({ method: 'POST', url: '/api/models', headers: { cookie }, payload: payload as object });
}

describe('POST /api/models', () => {
  it('从资源文件载入：201 返回行数，模型出现在列表中且可查询', async () => {
    const res = await create({
      modelName: 'sales_2026',
      source: 'file',
      resourcePath: '数据/sales.csv',
      format: 'csv',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'sales_2026', rowCount: 2 });

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: viewerCookie } });
    expect(list.json().items.map((m: { name: string }) => m.name)).toContain('sales_2026');

    const query = await app.inject({
      method: 'POST', url: '/api/models/query', headers: { cookie: viewerCookie },
      payload: { name: 'sales_2026' },
    });
    expect(query.json().rows).toEqual([[1, 10], [2, 20]]);
  });

  it('同名重复载入 = 覆盖（行数随文件内容变化）', async () => {
    const first = await create({ modelName: 'sales_2026', source: 'file', resourcePath: '数据/sales.csv' });
    expect(first.json().rowCount).toBe(2);

    fs.writeFileSync(path.join(resourceDir, '数据', 'sales.csv'), 'id,amount\n1,10\n2,20\n3,30\n', 'utf-8');
    const second = await create({ modelName: 'sales_2026', source: 'file', resourcePath: '数据/sales.csv' });
    expect(second.statusCode).toBe(201);
    expect(second.json().rowCount).toBe(3);

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: viewerCookie } });
    expect(list.json().items.filter((m: { name: string }) => m.name === 'sales_2026')).toHaveLength(1);
  });

  it('模型名不合法 400', async () => {
    for (const modelName of ['', '1abc', 'a-b', 'x'.repeat(65), '有中文']) {
      const res = await create({ modelName, source: 'file', resourcePath: '数据/sales.csv' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('模型名不合法');
    }
  });

  it('资源文件不可用 400：缺失、越界路径、非允许类型', async () => {
    const missing = await create({ modelName: 'm1', source: 'file', resourcePath: '数据/nope.csv' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('资源文件不可用');

    const escape = await create({ modelName: 'm1', source: 'file', resourcePath: '../../etc/passwd' });
    expect(escape.statusCode).toBe(400);

    fs.writeFileSync(path.join(resourceDir, 'notes.txt'), 'x', 'utf-8');
    const badType = await create({ modelName: 'm1', source: 'file', resourcePath: 'notes.txt' });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe('资源文件不可用');
  });

  it('SQL Server 分支：缺连接 / 缺表 → 400', async () => {
    const noConn = await create({ modelName: 'm1', source: 'sqlserver', object: 'dbo.sales' });
    expect(noConn.statusCode).toBe(400);
    expect(noConn.json().error).toBe('连接不可用');

    const unknownConn = await create({
      modelName: 'm1', source: 'sqlserver', connectionId: 'nope', object: 'dbo.sales',
    });
    expect(unknownConn.statusCode).toBe(400);
    expect(unknownConn.json().error).toBe('连接不可用');
  });

  it('数据来源无效 400', async () => {
    const res = await create({ modelName: 'm1', source: 'excel-magic' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('数据来源无效');
  });

  it('权限：dashboard.view-only 403 / 未登录 401', async () => {
    const viewer = await create(
      { modelName: 'm1', source: 'file', resourcePath: '数据/sales.csv' },
      viewerCookie,
    );
    expect(viewer.statusCode).toBe(403);

    const anon = await app.inject({
      method: 'POST', url: '/api/models',
      payload: { modelName: 'm1', source: 'file', resourcePath: '数据/sales.csv' },
    });
    expect(anon.statusCode).toBe(401);
  });
});
