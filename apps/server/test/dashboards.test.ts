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
let bobCookie: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['workflow_author'] });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');
});

const okPayload = { version: 2, dashboards: [{ id: 'd1', name: '仪表盘 1', widgets: [] }], activeId: 'd1', datasets: [] };

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
  it('列表：普通用户只见自有+共享，admin 见全量', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: adminCookie }, payload: { name: '公共', shared: true, payload: okPayload } });
    const bobList = await app.inject({ method: 'GET', url: '/api/dashboards', headers: { cookie: bobCookie } });
    expect(bobList.json()).toHaveLength(1);
    expect(bobList.json()[0].name).toBe('公共');
    const adminList = await app.inject({ method: 'GET', url: '/api/dashboards', headers: { cookie: adminCookie } });
    expect(adminList.json()).toHaveLength(2);
    expect(a.statusCode).toBe(201);
  });
  it('他人未共享：GET 403 / PUT 403 / DELETE 403；列表不出现', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    const id = created.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie }, payload: { name: 'hacked' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(403);
  });
  it('shared 仅 admin 可置真：alice 置真被忽略，admin 置真生效', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    const id = created.json().id;
    await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie }, payload: { shared: true } });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie } })).json().shared).toBe(false);
    await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: adminCookie }, payload: { shared: true } });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(200);
  });
  it('PUT 更新 name/payload，DELETE 后 404', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    const id = created.json().id;
    const put = await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie }, payload: { name: 'b', payload: { ...okPayload, activeId: 'x' } } });
    expect(put.json().name).toBe('b');
    expect(put.json().payload.activeId).toBe('x');
    expect((await app.inject({ method: 'DELETE', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie } })).statusCode).toBe(404);
  });
});
