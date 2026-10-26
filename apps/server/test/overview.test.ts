import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let db: Database.Database;
let store: ModelStore;
let adminCookie: string;
let viewerCookie: string;
let adminId: string;

const DAY = 24 * 60 * 60 * 1000;

/** 本地时区的当天 00:00（与接口切天口径一致） */
function localMidnight(offsetDays = 0): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays).getTime();
}

function dateKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

/** 直接插行以精确控制 created_at（接口按它切天） */
function insertWorkflow(createdAt: number): void {
  db.prepare(
    'INSERT INTO workflows (id, owner_id, name, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(nanoid(), adminId, `wf-${nanoid(6)}`, '{}', createdAt, createdAt);
}

function insertRow(table: string, createdAt: number): void {
  const id = nanoid();
  switch (table) {
    case 'dashboards':
      db.prepare(
        'INSERT INTO dashboards (id, owner_id, name, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run(id, adminId, `db-${id}`, '{}', createdAt, createdAt);
      return;
    case 'data_models':
      db.prepare(
        `INSERT INTO data_models (name, source_kind, source_ref, owner_id, loaded_at, row_count, columns, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(`m_${id}`, 'csv', '{}', adminId, createdAt, 0, '[]', createdAt);
      return;
    case 'connections':
      db.prepare(
        `INSERT INTO connections (id, owner_id, name, type, config_encrypted, shared, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, adminId, `conn-${id}`, 'sqlserver', 'x', 0, createdAt, createdAt);
      return;
    case 'jobs':
      db.prepare(
        `INSERT INTO jobs (id, owner_id, name, description, enabled, freq_type, cron_expr, timezone, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, adminId, `job-${id}`, null, 0, null, null, 'Asia/Shanghai', createdAt, createdAt);
      return;
    case 'users':
      db.prepare(
        'INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, `u_${id}`, 'x', 'dashboard_viewer', 'active', createdAt, createdAt);
      return;
    case 'audit_logs':
      db.prepare(
        `INSERT INTO audit_logs (id, user_id, username, action, resource, resource_name, description, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, adminId, 'admin1', 'create', 'workflow', null, `审计-${id}`, createdAt);
      return;
    default:
      throw new Error(`未知表：${table}`);
  }
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-overview-data-'));
  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  const admin = await users.create({ username: 'admin1', passwordHash, roles: ['admin'] });
  adminId = admin.id;
  await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
  });
  store = createModelStore({ db, config: cfg });
  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  adminCookie = await login('admin1');
  viewerCookie = await login('viewer');
});

afterEach(() => {
  store.close();
});

async function overview(query = '', cookie = adminCookie) {
  return app.inject({ method: 'GET', url: `/api/admin/overview${query}`, headers: { cookie } });
}

describe('GET /api/admin/overview', () => {
  it('默认 30 天：日期序列升序、末项为今天、长度 30', async () => {
    const res = await overview();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: number; dates: string[]; counts: Record<string, number[]> };
    expect(body.days).toBe(30);
    expect(body.dates).toHaveLength(30);
    expect(body.dates[29]).toBe(dateKey(Date.now()));
    expect(body.dates[0]).toBe(dateKey(localMidnight(29)));
    expect([...body.dates].sort()).toEqual(body.dates);
    for (const series of Object.values(body.counts)) expect(series).toHaveLength(30);
  });

  it('按 created_at 本地日期分桶：窗口外不计入、缺失日期补 0', async () => {
    insertWorkflow(localMidnight(0));
    insertWorkflow(localMidnight(0) + 3600_000);
    insertWorkflow(localMidnight(1));
    insertWorkflow(localMidnight(40));

    const res = await overview('?days=30');
    const { dates, counts } = res.json() as { dates: string[]; counts: Record<string, number[]> };
    const today = dates.indexOf(dateKey(localMidnight(0)));
    const yesterday = dates.indexOf(dateKey(localMidnight(1)));

    expect(counts.workflows[today]).toBe(2);
    expect(counts.workflows[yesterday]).toBe(1);
    expect(counts.workflows.reduce((a, b) => a + b, 0)).toBe(3); // 40 天前的那条被排除
    expect(counts.workflows[today - 2]).toBe(0); // 缺失日期补 0
  });

  it('七类来源各自统计（含审计记录）', async () => {
    insertWorkflow(localMidnight(2));
    insertRow('dashboards', localMidnight(2));
    insertRow('data_models', localMidnight(2));
    insertRow('connections', localMidnight(2));
    insertRow('jobs', localMidnight(2));
    insertRow('users', localMidnight(2));
    insertRow('audit_logs', localMidnight(2));

    const res = await overview('?days=7');
    const { dates, counts } = res.json() as { dates: string[]; counts: Record<string, number[]> };
    const day = dates.indexOf(dateKey(localMidnight(2)));
    for (const key of ['workflows', 'dashboards', 'models', 'connections', 'jobs', 'users', 'audits']) {
      expect(counts[key][day]).toBe(1);
    }
    // users 里此前还建了 admin1 与 viewer（created_at 为今天）
    expect(counts.users[dates.indexOf(dateKey(Date.now()))]).toBe(2);
  });

  it('days 校验：7 生效，0 / 366 / abc 均 400', async () => {
    const seven = await overview('?days=7');
    expect(seven.json().days).toBe(7);
    expect(seven.json().dates).toHaveLength(7);

    for (const bad of ['0', '366', 'abc', '1.5']) {
      const res = await overview(`?days=${bad}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('days');
    }
  });

  it('权限：非 admin 403 / 未登录 401', async () => {
    const viewer = await overview('', viewerCookie);
    expect(viewer.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/api/admin/overview' });
    expect(anon.statusCode).toBe(401);
  });
});
