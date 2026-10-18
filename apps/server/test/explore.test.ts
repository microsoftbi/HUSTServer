import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import { connectionsRepo } from '../src/modules/connections/repo.js';
import { checkReadOnly } from '../src/modules/explore/sqlGuard.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let db: Database.Database;
let store: ModelStore;
let adminId: string;
/** admin 私有（非 shared）连接 */
let adminConnId: string;
let adminCookie: string;
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-explore-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-explore-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n3,30\n', 'utf-8');
  fs.writeFileSync(path.join(resourceDir, 'small.csv'), 'id,amount\n9,90\n', 'utf-8');

  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  const admin = await users.create({ username: 'admin', passwordHash, roles: ['admin'] });
  adminId = admin.id;
  // workflow_author 拥有 connection.use，但非连接所有者
  await users.create({ username: 'wf', passwordHash, roles: ['workflow_author'] });
  // dashboard_viewer 无 connection.use
  await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });

  adminConnId = connectionsRepo(db).create({
    ownerId: adminId,
    name: 'admin 私有连接',
    type: 'sqlserver',
    configEncrypted: encryptConfig({ server: '127.0.0.1', database: 'd' }, cfg.encryptionKey),
    shared: false,
  }).id;

  store = createModelStore({ db, config: cfg });
  await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
  await store.load({ source: 'file', modelName: 'small_model', resourcePath: 'small.csv' }, null);

  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  adminCookie = await login('admin');
  wfCookie = await login('wf');
  viewerCookie = await login('viewer');
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe('checkReadOnly 只读 SQL 校验', () => {
  it('放行合法只读查询', () => {
    for (const sql of [
      'select 1',
      'SELECT * FROM t',
      '  select 1;',
      'with c as (select 1 as a) select * from c',
      'SeLeCt 1',
      '/* c */ select 1',
      '-- c\nselect 1',
      "select ';' as x",
    ]) {
      expect(checkReadOnly(sql), `期望放行：${JSON.stringify(sql)}`).toEqual({ ok: true });
    }
  });

  it('拒绝空语句与非只读语句', () => {
    for (const sql of [
      '',
      '   ',
      'update t set a=1',
      'delete from t',
      'drop table t',
      'create table t(a int)',
      'insert into t values(1)',
    ]) {
      const res = checkReadOnly(sql);
      expect(res.ok, `期望拒绝：${JSON.stringify(sql)}`).toBe(false);
      expect(res.reason).toBeTruthy();
    }
    expect(checkReadOnly('').reason).toBe('SQL 不能为空');
    expect(checkReadOnly('drop table t').reason).toContain('只读');
  });

  it('拒绝多语句', () => {
    for (const sql of ['select 1; select 2', 'select 1;drop table t']) {
      const res = checkReadOnly(sql);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('一次只能执行一条语句');
    }
  });

  it('注释前缀不能绕过只读检查', () => {
    for (const sql of ['/* c */ drop table t', '-- c\ndrop table t']) {
      const res = checkReadOnly(sql);
      expect(res.ok, `期望拒绝：${JSON.stringify(sql)}`).toBe(false);
      expect(res.reason).toContain('只读');
    }
  });
});

describe('GET /api/explore/models', () => {
  it('返回模型清单：name / rowCount / columns', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/explore/models', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as {
      items: Array<{ name: string; rowCount: number; columns: Array<{ name: string; type: string }> }>;
    }).items;
    expect(items).toHaveLength(2);

    const sales = items.find((m) => m.name === 'sales_model')!;
    expect(sales.rowCount).toBe(3);
    expect(sales.columns.map((c) => c.name)).toEqual(['id', 'amount']);
    expect(sales.columns.every((c) => typeof c.type === 'string')).toBe(true);

    const small = items.find((m) => m.name === 'small_model')!;
    expect(small.rowCount).toBe(1);
    expect(small.columns.map((c) => c.name)).toEqual(['id', 'amount']);
  });
});

describe('POST /api/explore/query 校验分支', () => {
  it('缺 SQL → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'model' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('缺少 SQL 语句');
  });

  it('source 缺失或非法 → 400', async () => {
    const missing = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { sql: 'select 1' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('source 必须为 connection 或 model');

    const illegal = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'foo', sql: 'select 1' },
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json().error).toBe('source 必须为 connection 或 model');
  });

  it('非只读 SQL → 400 且文案含「只读」', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'model', sql: 'drop table x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('只读');
  });
});

describe('POST /api/explore/query source=model', () => {
  it('执行 SELECT 返回 columns 与 rows', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'model', sql: 'select * from sales_model' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { columns: Array<{ name: string; type: string }>; rows: unknown[][]; truncated: boolean };
    expect(body.columns.map((c) => c.name)).toEqual(['id', 'amount']);
    expect(body.columns.map((c) => c.type)).toEqual(['number', 'number']);
    expect(body.rows).toEqual([[1, 10], [2, 20], [3, 30]]);
    expect(body.truncated).toBe(false);
  });

  it('limit 生效：模型 3 行取 1 行时 rows 长度为 1 且 truncated=true', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'model', sql: 'select * from sales_model', limit: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[][]; truncated: boolean };
    expect(body.rows).toHaveLength(1);
    expect(body.rows).toEqual([[1, 10]]);
    expect(body.truncated).toBe(true);
  });
});

describe('POST /api/explore/query source=connection', () => {
  it('缺 connectionId → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'connection', sql: 'select 1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('缺少连接 ID');
  });

  it('连接不存在 → 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: adminCookie },
      payload: { source: 'connection', connectionId: 'nope', sql: 'select 1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('连接不存在');
  });

  it('既非 shared 也不属于当前用户 → 403', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/query', headers: { cookie: wfCookie },
      payload: { source: 'connection', connectionId: adminConnId, sql: 'select 1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('无权使用该连接');
  });
});

describe('POST /api/explore/columns', () => {
  it('缺 connectionId → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/columns', headers: { cookie: adminCookie },
      payload: { name: 't' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('缺少连接 ID');
  });

  it('缺 name → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/columns', headers: { cookie: adminCookie },
      payload: { connectionId: adminConnId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('缺少表名');
  });

  it('连接不存在 → 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/columns', headers: { cookie: adminCookie },
      payload: { connectionId: 'nope', name: 't' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('连接不存在');
  });

  it('既非 shared 也不属于当前用户 → 403', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/explore/columns', headers: { cookie: wfCookie },
      payload: { connectionId: adminConnId, name: 't' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('无权使用该连接');
  });
});

describe('数据探索接口权限（connection.use）', () => {
  function getModels(cookie?: string) {
    return app.inject({
      method: 'GET', url: '/api/explore/models', headers: cookie ? { cookie } : {},
    });
  }
  function postQuery(cookie?: string) {
    return app.inject({
      method: 'POST', url: '/api/explore/query', headers: cookie ? { cookie } : {},
      payload: { source: 'model', sql: 'select 1' },
    });
  }
  function postColumns(cookie?: string) {
    return app.inject({
      method: 'POST', url: '/api/explore/columns', headers: cookie ? { cookie } : {},
      payload: { connectionId: adminConnId, name: 't' },
    });
  }

  it('GET /api/explore/models：无 connection.use → 403，未登录 → 401', async () => {
    expect((await getModels(viewerCookie)).statusCode).toBe(403);
    expect((await getModels()).statusCode).toBe(401);
  });

  it('POST /api/explore/query：无 connection.use → 403，未登录 → 401', async () => {
    expect((await postQuery(viewerCookie)).statusCode).toBe(403);
    expect((await postQuery()).statusCode).toBe(401);
  });

  it('POST /api/explore/columns：无 connection.use → 403，未登录 → 401', async () => {
    expect((await postColumns(viewerCookie)).statusCode).toBe(403);
    expect((await postColumns()).statusCode).toBe(401);
  });
});
