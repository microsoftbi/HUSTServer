import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(64), HUSTSERVER_DATA_DIR: '/tmp/hustserver-test' });

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let aliceCookie: string;
let carolCookie: string;
let bobCookie: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['dashboard_author'] });
  await usersRepo(db).create({ username: 'carol', passwordHash: await hashPassword('carol123'), roles: ['dashboard_author'] });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['dashboard_viewer'] });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  carolCookie = await login('carol', 'carol123');
  bobCookie = await login('bob', 'bob12345');
});

const okPayload = { version: 2, dashboards: [{ id: 'd1', name: '仪表盘 1', widgets: [] }], activeId: 'd1', datasets: [] };

async function createDashboard(cookie: string, payload: Record<string, unknown>): Promise<{ id: string; statusCode: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie }, payload });
  return { id: res.json().id, statusCode: res.statusCode };
}

describe('dashboard routes', () => {
  it('未登录 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboards' })).statusCode).toBe(401);
  });

  it('创建成功 201，GET 单条返回 payload 对象', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: '销售看板', payload: okPayload } });
    expect(created.statusCode).toBe(201);
    const one = await app.inject({ method: 'GET', url: `/api/dashboards/${created.json().id}`, headers: { cookie: aliceCookie } });
    expect(one.json().payload).toEqual(okPayload);
  });

  it('缺名称 400；payload 非对象 400；payload 超 8MB 413 payload_too_large', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: ' ', payload: okPayload } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'x', payload: 'str' } })).statusCode).toBe(400);
    const big = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'x', payload: { a: 'x'.repeat(9 * 1024 * 1024) } } });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('payload_too_large');
  });

  it('查看能力：viewer 的 GET /api/dashboards → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboards', headers: { cookie: bobCookie } })).statusCode).toBe(200);
  });

  it('查看全部可见：viewer 列表长度 2，且可查看他人未共享单条（200）', async () => {
    const aliceOwn = await createDashboard(aliceCookie, { name: 'a', payload: okPayload });
    const shared = await createDashboard(adminCookie, { name: '公共', shared: true, payload: okPayload });
    expect(aliceOwn.statusCode).toBe(201);
    expect(shared.statusCode).toBe(201);

    const bobList = await app.inject({ method: 'GET', url: '/api/dashboards', headers: { cookie: bobCookie } });
    expect(bobList.json()).toHaveLength(2);

    // viewer 可查看他人未共享的仪表板
    const one = await app.inject({ method: 'GET', url: `/api/dashboards/${aliceOwn.id}`, headers: { cookie: bobCookie } });
    expect(one.statusCode).toBe(200);
    expect(one.json().payload).toEqual(okPayload);
  });

  it('编辑限制：viewer 无 dashboard.edit，POST/PUT/DELETE → 403', async () => {
    const carolOwn = await createDashboard(carolCookie, { name: 'c', payload: okPayload });
    const post = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: bobCookie }, payload: { name: 'x', payload: okPayload } });
    expect(post.statusCode).toBe(403);
    expect(post.json().error).toBe('需要「仪表板编辑」权限');
    expect((await app.inject({ method: 'PUT', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: bobCookie }, payload: { name: 'hacked' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: bobCookie } })).statusCode).toBe(403);
  });

  it('编辑归属：alice 编辑自有 200；编辑他人未共享 → 403 无权编辑该仪表板', async () => {
    const aliceOwn = await createDashboard(aliceCookie, { name: 'a', payload: okPayload });
    const carolOwn = await createDashboard(carolCookie, { name: 'c', payload: okPayload });

    const ownPut = await app.inject({ method: 'PUT', url: `/api/dashboards/${aliceOwn.id}`, headers: { cookie: aliceCookie }, payload: { name: 'a2' } });
    expect(ownPut.statusCode).toBe(200);

    const otherPut = await app.inject({ method: 'PUT', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: aliceCookie }, payload: { name: 'hacked' } });
    expect(otherPut.statusCode).toBe(403);
    expect(otherPut.json().error).toBe('无权编辑该仪表板');
  });

  it('shared 仅 admin 可置真：carol 置真被忽略；admin 置真生效后 alice 可编辑 carol 的仪表板', async () => {
    const carolOwn = await createDashboard(carolCookie, { name: 'c', payload: okPayload });

    await app.inject({ method: 'PUT', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: carolCookie }, payload: { shared: true } });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: carolCookie } })).json().shared).toBe(false);

    const beforeShare = await app.inject({ method: 'PUT', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: aliceCookie }, payload: { name: 'x' } });
    expect(beforeShare.statusCode).toBe(403);

    await app.inject({ method: 'PUT', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: adminCookie }, payload: { shared: true } });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: aliceCookie } })).json().shared).toBe(true);

    const afterShare = await app.inject({ method: 'PUT', url: `/api/dashboards/${carolOwn.id}`, headers: { cookie: aliceCookie }, payload: { name: 'y' } });
    expect(afterShare.statusCode).toBe(200);
  });

  it('PUT 更新 name/payload，DELETE 后 404', async () => {
    const aliceOwn = await createDashboard(aliceCookie, { name: 'a', payload: okPayload });
    const put = await app.inject({ method: 'PUT', url: `/api/dashboards/${aliceOwn.id}`, headers: { cookie: aliceCookie }, payload: { name: 'b', payload: { ...okPayload, activeId: 'x' } } });
    expect(put.json().name).toBe('b');
    expect(put.json().payload.activeId).toBe('x');
    expect((await app.inject({ method: 'DELETE', url: `/api/dashboards/${aliceOwn.id}`, headers: { cookie: aliceCookie } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${aliceOwn.id}`, headers: { cookie: aliceCookie } })).statusCode).toBe(404);
  });
});
