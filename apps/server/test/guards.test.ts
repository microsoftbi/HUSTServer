import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { sessionsRepo } from '../src/modules/auth/sessions.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { requireAuth, requireCap } from '../src/plugins/guards.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const PASSWORD = 'pw12345678';

let app: FastifyInstance;
let db: Database.Database;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const hash = await hashPassword(PASSWORD);
  users.create({ username: 'admin', passwordHash: hash, roles: ['admin'] });
  users.create({ username: 'wf', passwordHash: hash, roles: ['workflow_author'] });
  users.create({ username: 'dashAuthor', passwordHash: hash, roles: ['dashboard_author'] });
  users.create({ username: 'viewer', passwordHash: hash, roles: ['dashboard_viewer'] });

  app = await buildServer({ db, config: cfg, logger: false });
  // 探针路由：以真实守卫链（requireAuth + requireCap）挂载一个需 workflow 能力的端点，
  // 用于端到端验证 requireCap 的 403 文案（业务路由的 requireCap 落地属 Task 5）。
  const auth = requireAuth({ users: usersRepo(db), sessions: sessionsRepo(db) });
  app.put('/__test__/cap-workflow', { preHandler: [auth, requireCap('workflow')] }, async () => ({ ok: true }));
  await app.ready();
});

describe('能力守卫 requireCap', () => {
  it('/api/auth/me 返回 roles 与 capabilities（viewer 仅 dashboard.view）', async () => {
    const cookie = await login('viewer');
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.id).toBe('string');
    expect(body.username).toBe('viewer');
    expect(body.roles).toEqual(['dashboard_viewer']);
    expect(body.capabilities).toEqual(['dashboard.view']);
  });

  it('admin 的 capabilities 长度为 8', async () => {
    const cookie = await login('admin');
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual(['admin']);
    expect(res.json().capabilities).toHaveLength(8);
  });

  it('login 返回 roles 与 capabilities 数组', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'wf', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual(['workflow_author']);
    expect(res.json().capabilities).toContain('workflow');
    expect(res.json().capabilities).not.toContain('admin');
  });

  it('viewer 访问需 workflow 能力的端点 403 需要「工作流」权限', async () => {
    const cookie = await login('viewer');
    const res = await app.inject({
      method: 'PUT',
      url: '/__test__/cap-workflow',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '需要「工作流」权限' });
  });

  it('admin 访问需 workflow 能力的端点通过', async () => {
    const cookie = await login('admin');
    const res = await app.inject({
      method: 'PUT',
      url: '/__test__/cap-workflow',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('viewer 访问受 admin 能力保护的既有端点 403 需要「管理员」权限', async () => {
    const cookie = await login('viewer');
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '需要「管理员」权限' });
  });

  it('未登录访问受保护端点 401', async () => {
    const res = await app.inject({ method: 'PUT', url: '/__test__/cap-workflow', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
