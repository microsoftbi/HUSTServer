import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { auditRepo, type AuditRepo } from '../src/modules/audit/repo.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let store: ModelStore;
let db: Database.Database;
let audit: AuditRepo;
let adminCookie: string;
let authorCookie: string;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

function loadModel(cookie: string | null = adminCookie) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/audit-logs/load-model',
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-audit-model-'));
  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  await users.create({ username: 'admin', passwordHash, roles: ['admin'] });
  await users.create({ username: 'author', passwordHash, roles: ['workflow_author'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
  });
  store = createModelStore({ db, config: cfg });
  audit = auditRepo(db);

  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  adminCookie = await login('admin');
  authorCookie = await login('author');
  // 登录本身会写审计；清空以保证基线为 0
  db.prepare('DELETE FROM audit_logs').run();
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe('POST /api/admin/audit-logs/load-model', () => {
  it('把审计日志加载为模型 audit_logs，并可通过模型查询读回', async () => {
    audit.record({
      userId: null,
      username: 'alice',
      action: 'create',
      resource: 'workflow',
      resourceName: 'wf-1',
      description: '创建了工作流「wf-1」',
    });
    audit.record({
      userId: null,
      username: 'bob',
      action: 'login',
      resource: 'auth',
      resourceName: 'bob',
      description: '登录成功（127.0.0.1）',
    });

    const res = await loadModel();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'audit_logs', rowCount: 2 });

    const list = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: { cookie: adminCookie },
    });
    const model = list
      .json()
      .items.find((m: { name: string }) => m.name === 'audit_logs');
    expect(model).toMatchObject({ sourceKind: 'audit', rowCount: 2 });

    const query = await app.inject({
      method: 'POST',
      url: '/api/models/query',
      headers: { cookie: adminCookie },
      payload: { name: 'audit_logs' },
    });
    expect(query.statusCode).toBe(200);
    const body = query.json() as {
      columns: Array<{ name: string; type: string }>;
      rows: Array<Array<string | number | null>>;
    };
    expect(body.columns.map((c) => c.name)).toEqual([
      'id',
      'username',
      'action',
      'resource',
      'resource_name',
      'description',
      'created_at',
    ]);
    expect(body.rows).toHaveLength(2);
    // created_at 以时间戳入库，按 ISO 字符串返回
    expect(body.columns.find((c) => c.name === 'created_at')?.type).toBe('date');
    expect(String(body.rows[0][6])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('重复加载为整体覆盖而不是追加', async () => {
    audit.record({
      userId: null,
      username: 'alice',
      action: 'other',
      resource: 'job',
      description: '执行了 Job',
    });

    const first = await loadModel();
    expect(first.json()).toEqual({ name: 'audit_logs', rowCount: 1 });

    // 第一次加载本身也写入了一条审计，第二次加载应包含它（1 + 1）
    const second = await loadModel();
    expect(second.json()).toEqual({ name: 'audit_logs', rowCount: 2 });

    const list = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: { cookie: adminCookie },
    });
    const model = list
      .json()
      .items.find((m: { name: string }) => m.name === 'audit_logs');
    expect(model).toMatchObject({ rowCount: 2 });
  });

  it('加载动作本身写入审计记录', async () => {
    audit.record({
      userId: null,
      username: 'alice',
      action: 'delete',
      resource: 'dashboard',
      description: '删除了仪表板',
    });

    await loadModel();

    const logs = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-logs',
      headers: { cookie: adminCookie },
    });
    const items = logs.json().items as Array<{ action: string; resource: string; resource_name: string | null }>;
    expect(
      items.some(
        (i) => i.action === 'create' && i.resource === 'model' && i.resource_name === 'audit_logs',
      ),
    ).toBe(true);
  });

  it('非管理员 403，未登录 401', async () => {
    expect((await loadModel(authorCookie)).statusCode).toBe(403);
    expect((await loadModel(null)).statusCode).toBe(401);
  });
});
