import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeSession, openModelDb } from '@hustserver/engine';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { dataModelsRepo } from '../src/modules/models/repo.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let store: ModelStore;
let db: Database.Database;
let cfg: AppConfig;
let viewerCookie: string;
let viewerId: string;

const CSV = [
  'region,amount,qty,note',
  '华东,10.5,3,',
  '华北,,5,abc',
  '华东,20,,',
  '华南,30.5,2,abc',
].join('\n');

interface ColumnStatsLike {
  name: string;
  type: string;
  numeric: boolean;
  nonNull: number;
  nulls: number;
  distinct: number;
  min?: number | null;
  max?: number | null;
  avg?: number | null;
  median?: number | null;
  stddev?: number | null;
}

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

/** 建 store + app（store 首次使用时才打开 DuckDB 会话，故需在外部写库前先 close） */
async function buildApp(): Promise<void> {
  store = createModelStore({ db, config: cfg });
  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  viewerCookie = await login('viewer');
}

async function stats(name: string) {
  return app.inject({
    method: 'POST', url: '/api/models/stats',
    headers: { cookie: viewerCookie },
    payload: { name },
  });
}

function columnOf(body: { columns: ColumnStatsLike[] }, name: string): ColumnStatsLike {
  const found = body.columns.find((c) => c.name === name);
  if (!found) throw new Error(`未找到列 ${name}`);
  return found;
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-stats-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-stats-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), CSV, 'utf-8');

  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  const viewer = await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });
  viewerId = viewer.id;

  cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  await buildApp();
  await store.load({ source: 'file', modelName: 'stats_model', resourcePath: 'sales.csv' }, viewerId);
});

afterEach(() => {
  store.close();
});

describe('POST /api/models/stats', () => {
  it('每列给出非空/空值/不重复数，数值列额外给五项统计', async () => {
    const res = await stats('stats_model');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; rowCount: number; columns: ColumnStatsLike[] };
    expect(body.name).toBe('stats_model');
    expect(body.rowCount).toBe(4);
    expect(body.columns.map((c) => c.name)).toEqual(['region', 'amount', 'qty', 'note']);

    // 文本列：只给基础三项，无 min/max
    const region = columnOf(body, 'region');
    expect(region).toMatchObject({ numeric: false, nonNull: 4, nulls: 0, distinct: 3 });
    expect(region.min).toBeUndefined();
    expect(region.avg).toBeUndefined();

    const note = columnOf(body, 'note');
    expect(note).toMatchObject({ numeric: false, nonNull: 2, nulls: 2, distinct: 1 });

    // 数值列（DOUBLE）：空值不计入非空/不重复
    const amount = columnOf(body, 'amount');
    expect(amount).toMatchObject({
      numeric: true, nonNull: 3, nulls: 1, distinct: 3, min: 10.5, max: 30.5, median: 20,
    });
    expect(amount.avg).toBeCloseTo(20.333333, 5);
    expect(amount.stddev).toBeCloseTo(10.004166, 5);

    // 数值列（BIGINT）
    const qty = columnOf(body, 'qty');
    expect(qty).toMatchObject({
      numeric: true, nonNull: 3, nulls: 1, distinct: 3, min: 2, max: 5, median: 3,
    });
    expect(qty.avg).toBeCloseTo(3.333333, 5);
    expect(qty.stddev).toBeCloseTo(1.527525, 5);
  });

  it('数值列全为空时数值统计项为 null', async () => {
    // 直接建 DuckDB 表（CSV auto_detect 无法造出全空的数值列）；先关掉已持有会话的 store
    store.close();
    const seed = await openModelDb(cfg.modelDbFile);
    // CREATE TABLE AS SELECT（无 FROM）本身产生一行全 NULL 数据
    await seed.connection.run('CREATE TABLE all_null AS SELECT CAST(NULL AS BIGINT) AS a');
    closeSession(seed);
    dataModelsRepo(db).upsert({
      name: 'all_null',
      sourceKind: 'csv',
      sourceRef: JSON.stringify({ resourcePath: 'sales.csv' }),
      ownerId: null,
      loadedAt: Date.now(),
      rowCount: 1,
      columns: JSON.stringify([{ name: 'a', type: 'BIGINT' }]),
    });
    await buildApp();

    const res = await stats('all_null');
    expect(res.statusCode).toBe(200);
    expect(res.json().columns[0]).toMatchObject({
      name: 'a', numeric: true, nonNull: 0, nulls: 1, distinct: 0,
      min: null, max: null, avg: null, median: null, stddev: null,
    });
  });

  it('缺模型名 400 / 模型不存在 404 / 未登录 401', async () => {
    const noName = await app.inject({
      method: 'POST', url: '/api/models/stats',
      headers: { cookie: viewerCookie }, payload: {},
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toBe('缺少模型名');

    const missing = await stats('nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('模型不存在');

    const anon = await app.inject({
      method: 'POST', url: '/api/models/stats', payload: { name: 'stats_model' },
    });
    expect(anon.statusCode).toBe(401);
  });
});
