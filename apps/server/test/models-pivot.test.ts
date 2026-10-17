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

const CSV = [
  'region,year,amount,status',
  '华东,2024,50,open',
  '华北,2024,10,paid',
  '华北,2025,20,open',
  '华南,2024,30,paid',
  '华南,2024,40,paid',
].join('\n');

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

/** 把 [行键…, 列键…, 值…] 的结果转成 `${行键}>${列键}` → 值 的映射，避免依赖排序细节 */
function toMap(result: { rows: unknown[][]; rowFields: string[]; columnFields: string[] }, valueIndex: number) {
  const dims = result.rowFields.length + result.columnFields.length;
  const map = new Map<string, unknown>();
  for (const row of result.rows) {
    const keys = row.slice(0, dims).map((v) => String(v)).join('>');
    map.set(keys, row[dims + valueIndex]);
  }
  return map;
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-pivot-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-pivot-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), CSV, 'utf-8');

  const db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  await users.create({ username: 'author', passwordHash, roles: ['dashboard_author'] });
  await users.create({ username: 'wf', passwordHash, roles: ['workflow_author'] });

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
});

afterEach(() => {
  store.close();
});

async function pivot(payload: unknown, cookie = authorCookie) {
  return app.inject({ method: 'POST', url: '/api/models/pivot', headers: { cookie }, payload: payload as object });
}

describe('POST /api/models/pivot', () => {
  it('行=region、列=year、sum(amount)：聚合结果正确且覆盖全量行', async () => {
    const res = await pivot({
      name: 'sales_model',
      rows: ['region'],
      columns: ['year'],
      values: [{ field: 'amount', agg: 'sum' }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rowFields).toEqual(['region']);
    expect(body.columnFields).toEqual(['year']);
    expect(body.values).toEqual([{ field: 'amount', agg: 'sum', label: 'sum(amount)' }]);
    expect(body.truncated).toBe(false);
    expect(body.totalRows).toBe(5);
    expect(toMap(body, 0)).toEqual(
      new Map([
        ['华东>2024', 50],
        ['华北>2024', 10],
        ['华北>2025', 20],
        ['华南>2024', 70],
      ]),
    );
  });

  it('多级行 + 多度量：返回两个值列', async () => {
    const res = await pivot({
      name: 'sales_model',
      rows: ['region', 'year'],
      columns: [],
      values: [
        { field: 'amount', agg: 'sum' },
        { field: 'amount', agg: 'count' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.values.map((v: { label: string }) => v.label)).toEqual(['sum(amount)', 'count(amount)']);
    const sums = toMap(body, 0);
    const counts = toMap(body, 1);
    expect(sums.get('华南>2024')).toBe(70);
    expect(counts.get('华南>2024')).toBe(2);
    expect(sums.get('华北>2025')).toBe(20);
    expect(counts.get('华北>2025')).toBe(1);
  });

  it('筛选：status=paid 只统计已付；值列表为空表示不过滤', async () => {
    const filtered = await pivot({
      name: 'sales_model',
      rows: ['region'],
      columns: [],
      values: [{ field: 'amount', agg: 'sum' }],
      filters: [{ field: 'status', values: ['paid'] }],
    });
    expect(filtered.statusCode).toBe(200);
    const filteredSums = toMap(filtered.json(), 0);
    expect(filteredSums).toEqual(new Map([['华北', 10], ['华南', 70]]));

    const noFilter = await pivot({
      name: 'sales_model',
      rows: ['region'],
      columns: [],
      values: [{ field: 'amount', agg: 'sum' }],
      filters: [{ field: 'status', values: [] }],
    });
    expect(noFilter.json().totalRows).toBe(5);
    expect(toMap(noFilter.json(), 0).get('华东')).toBe(50);
  });

  it('无维度（仅数值）时返回单行总计', async () => {
    const res = await pivot({
      name: 'sales_model',
      rows: [],
      columns: [],
      values: [{ field: 'amount', agg: 'sum' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([[150]]);
  });

  it('limit 生效：超过上限时 truncated=true', async () => {
    const res = await pivot({
      name: 'sales_model',
      rows: ['region'],
      columns: ['year'],
      values: [{ field: 'amount', agg: 'sum' }],
      limit: 1,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(1);
    expect(res.json().truncated).toBe(true);
  });

  it('字段白名单：未知字段 400（detail 指明字段名）', async () => {
    const res = await pivot({
      name: 'sales_model',
      rows: ['nope'],
      columns: [],
      values: [{ field: 'amount', agg: 'sum' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('透视失败');
    expect(res.json().detail).toBe('未知字段：nope');
  });

  it('请求体校验：缺模型名 / 无数值 / 聚合非法 / 字段数超限 → 400', async () => {
    expect((await pivot({ rows: [], columns: [], values: [{ field: 'amount', agg: 'sum' }] })).statusCode).toBe(400);
    expect((await pivot({ name: 'sales_model', values: [] })).json().error).toBe('至少需要一个数值字段');
    expect(
      (await pivot({ name: 'sales_model', values: [{ field: 'amount', agg: 'median' }] })).json().error,
    ).toBe('不支持的聚合方式：median');
    expect(
      (await pivot({
        name: 'sales_model',
        rows: ['region', 'year', 'status', 'amount'],
        values: [{ field: 'amount', agg: 'sum' }],
      })).json().error,
    ).toBe('行字段最多 3 个字段');
    expect(
      (await pivot({
        name: 'sales_model',
        rows: ['region', 'region'],
        values: [{ field: 'amount', agg: 'sum' }],
      })).json().error,
    ).toBe('行字段存在重复字段');
  });

  it('模型不存在 404 / 无 dashboard.view 403 / 未登录 401', async () => {
    const missing = await pivot({
      name: 'nope',
      rows: [],
      columns: [],
      values: [{ field: 'amount', agg: 'sum' }],
    });
    expect(missing.statusCode).toBe(404);

    const wf = await pivot(
      { name: 'sales_model', rows: [], columns: [], values: [{ field: 'amount', agg: 'sum' }] },
      wfCookie,
    );
    expect(wf.statusCode).toBe(403);

    const anon = await app.inject({
      method: 'POST', url: '/api/models/pivot',
      payload: { name: 'sales_model', values: [{ field: 'amount', agg: 'sum' }] },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('POST /api/models/distinct', () => {
  it('返回去重值并标注是否截断', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/models/distinct', headers: { cookie: authorCookie },
      payload: { name: 'sales_model', field: 'status' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.sort()).toEqual(['open', 'paid']);
    expect(res.json().truncated).toBe(false);

    const limited = await app.inject({
      method: 'POST', url: '/api/models/distinct', headers: { cookie: authorCookie },
      payload: { name: 'sales_model', field: 'status', limit: 1 },
    });
    expect(limited.json().values).toHaveLength(1);
    expect(limited.json().truncated).toBe(true);
  });

  it('未知字段 400 / 模型不存在 404 / 缺列名 400', async () => {
    const unknown = await app.inject({
      method: 'POST', url: '/api/models/distinct', headers: { cookie: authorCookie },
      payload: { name: 'sales_model', field: 'nope' },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().detail).toBe('未知字段：nope');

    const missing = await app.inject({
      method: 'POST', url: '/api/models/distinct', headers: { cookie: authorCookie },
      payload: { name: 'nope', field: 'status' },
    });
    expect(missing.statusCode).toBe(404);

    const noField = await app.inject({
      method: 'POST', url: '/api/models/distinct', headers: { cookie: authorCookie },
      payload: { name: 'sales_model' },
    });
    expect(noField.statusCode).toBe(400);
    expect(noField.json().error).toBe('缺少列名');
  });
});
