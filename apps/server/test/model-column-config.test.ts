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
let viewerCookie: string;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

function getConfig(cookie: string, name = 'm_types') {
  return app.inject({
    method: 'GET',
    url: `/api/models/${name}/column-config`,
    headers: { cookie },
  });
}

function putConfig(cookie: string, columns: unknown, name = 'm_types') {
  return app.inject({
    method: 'PUT',
    url: `/api/models/${name}/column-config`,
    headers: { cookie },
    payload: { columns } as object,
  });
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-model-config-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-model-config-res-'));
  fs.mkdirSync(path.join(resourceDir, '数据'));
  // code 为带前导零的文本，便于验证「文本 → 数字」的类型改写
  fs.writeFileSync(
    path.join(resourceDir, '数据', 'types.csv'),
    'id,code,label\n1,001,A\n2,002,B\n',
    'utf-8',
  );

  const db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
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

  const created = await app.inject({
    method: 'POST', url: '/api/models', headers: { cookie: authorCookie },
    payload: { modelName: 'm_types', source: 'file', resourcePath: '数据/types.csv' },
  });
  expect(created.statusCode).toBe(201);
});

afterEach(() => {
  store.close();
});

describe('数据模型列类型配置', () => {
  it('默认无配置：返回原始类型，configType 为 null', async () => {
    const res = await getConfig(authorCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'm_types' });
    expect(res.json().columns).toEqual([
      { name: 'id', type: 'BIGINT', configType: null },
      { name: 'code', type: 'VARCHAR', configType: null },
      { name: 'label', type: 'VARCHAR', configType: null },
    ]);
  });

  it('保存配置后：列表、预览、统计、透视均按配置类型生效', async () => {
    const put = await putConfig(authorCookie, [
      { name: 'code', type: 'number' },
      { name: 'label', type: 'string' },
    ]);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, count: 2 });

    // 配置回读
    const cfgRes = await getConfig(authorCookie);
    expect(cfgRes.json().columns).toEqual([
      { name: 'id', type: 'BIGINT', configType: null },
      { name: 'code', type: 'VARCHAR', configType: 'number' },
      { name: 'label', type: 'VARCHAR', configType: 'string' },
    ]);

    // 模型列表：code 的类型被改写为 DOUBLE（前端的数值列判定依赖此类型名）
    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: viewerCookie } });
    const model = list.json().items.find((m: { name: string }) => m.name === 'm_types');
    expect(model.columns.find((c: { name: string }) => c.name === 'code').type).toBe('DOUBLE');

    // 数据预览：code 按数字返回
    const query = await app.inject({
      method: 'POST', url: '/api/models/query', headers: { cookie: viewerCookie },
      payload: { name: 'm_types' },
    });
    expect(query.json().columns[1]).toEqual({ name: 'code', type: 'number' });
    expect(query.json().rows).toEqual([[1, 1, 'A'], [2, 2, 'B']]);

    // 列统计：code 被识别为数值列并算出平均值
    const stats = await app.inject({
      method: 'POST', url: '/api/models/stats', headers: { cookie: viewerCookie },
      payload: { name: 'm_types' },
    });
    const codeStats = stats.json().columns.find((c: { name: string }) => c.name === 'code');
    expect(codeStats).toMatchObject({ numeric: true, type: 'DOUBLE', avg: 1.5 });

    // 透视：对文本列求和时按数字下推
    const pivot = await app.inject({
      method: 'POST', url: '/api/models/pivot', headers: { cookie: viewerCookie },
      payload: {
        name: 'm_types',
        rows: ['id'],
        columns: [],
        values: [{ field: 'code', agg: 'sum' }],
        filters: [],
      },
    });
    expect(pivot.statusCode).toBe(200);
    expect(pivot.json().rows).toEqual([[1, 1], [2, 2]]);
  });

  it('恢复原始类型：全部置空后配置被删除', async () => {
    await putConfig(authorCookie, [{ name: 'code', type: 'number' }]);
    const cleared = await putConfig(authorCookie, [{ name: 'code', type: null }]);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().count).toBe(0);

    const cfgRes = await getConfig(authorCookie);
    expect(cfgRes.json().columns[1]).toEqual({ name: 'code', type: 'VARCHAR', configType: null });

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: viewerCookie } });
    const model = list.json().items.find((m: { name: string }) => m.name === 'm_types');
    expect(model.columns.find((c: { name: string }) => c.name === 'code').type).toBe('VARCHAR');
  });

  it('非法配置 400：未知列 / 不支持的类型 / 重复列 / 非数组', async () => {
    const unknownCol = await putConfig(authorCookie, [{ name: 'nope', type: 'number' }]);
    expect(unknownCol.statusCode).toBe(400);
    expect(unknownCol.json().error).toBe('未知列：nope');

    const badType = await putConfig(authorCookie, [{ name: 'code', type: 'money' }]);
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe('不支持的类型：money');

    const dup = await putConfig(authorCookie, [
      { name: 'code', type: 'number' },
      { name: 'code', type: 'string' },
    ]);
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe('列「code」重复');

    const notArray = await app.inject({
      method: 'PUT', url: '/api/models/m_types/column-config', headers: { cookie: authorCookie },
      payload: { columns: 'code' } as unknown as object,
    });
    expect(notArray.statusCode).toBe(400);
    expect(notArray.json().error).toBe('columns 必须是数组');

    const missing = await getConfig(authorCookie, 'nope');
    expect(missing.statusCode).toBe(404);
  });

  it('权限：viewer 403 / 未登录 401', async () => {
    const viewer = await getConfig(viewerCookie);
    expect(viewer.statusCode).toBe(403);

    const anonPut = await app.inject({
      method: 'PUT', url: '/api/models/m_types/column-config',
      payload: { columns: [{ name: 'code', type: 'number' }] },
    });
    expect(anonPut.statusCode).toBe(401);
  });

  it('重命名跟随、删除清理', async () => {
    await putConfig(authorCookie, [{ name: 'code', type: 'number' }]);

    const renamed = await app.inject({
      method: 'PATCH', url: '/api/models/m_types', headers: { cookie: authorCookie },
      payload: { newName: 'm_types_new' },
    });
    expect(renamed.statusCode).toBe(200);
    const afterRename = await getConfig(authorCookie, 'm_types_new');
    expect(afterRename.json().columns[1]).toEqual({ name: 'code', type: 'VARCHAR', configType: 'number' });

    await app.inject({ method: 'DELETE', url: '/api/models/m_types_new', headers: { cookie: authorCookie } });

    // 用同名重新载入后，旧配置不应残留
    const recreated = await app.inject({
      method: 'POST', url: '/api/models', headers: { cookie: authorCookie },
      payload: { modelName: 'm_types_new', source: 'file', resourcePath: '数据/types.csv' },
    });
    expect(recreated.statusCode).toBe(201);
    const cfgRes = await getConfig(authorCookie, 'm_types_new');
    expect(cfgRes.json().columns[1].configType).toBeNull();
  });
});
