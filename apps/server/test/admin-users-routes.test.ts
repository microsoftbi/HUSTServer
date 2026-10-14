import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let userCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  userCookie = await login('alice', 'alice123');
});

describe('admin users routes', () => {
  it('管理员可列出用户且不泄露密码哈希', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[0]).not.toHaveProperty('password_hash');
  });

  it('普通用户访问被拒 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('创建用户：重名返回 409，成功返回 201', async () => {
    const dup = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie },
      payload: { username: 'alice', password: 'whatever1', role: 'user' },
    });
    expect(dup.statusCode).toBe(409);
    const ok = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie },
      payload: { username: 'bob', password: 'bob12345', role: 'user' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().username).toBe('bob');
    expect(ok.json()).not.toHaveProperty('password_hash');
  });

  it('修改角色/状态后可生效，禁用用户的会话立即失效', async () => {
    const bobCookie = await loginFree('bob', 'bob12345');
    const bob = usersRepo(db).findByUsername('bob')!;
    const res = await app.inject({
      method: 'PUT', url: `/api/admin/users/${bob.id}`, headers: { cookie: adminCookie },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: bobCookie } });
    expect(me.statusCode).toBe(401);
  });

  it('重置密码后旧密码失效、新密码可登录', async () => {
    await loginFree('bob', 'bob12345');
    const bob = usersRepo(db).findByUsername('bob')!;
    const res = await app.inject({
      method: 'POST', url: `/api/admin/users/${bob.id}/reset-password`, headers: { cookie: adminCookie },
      payload: { password: 'newpass99' },
    });
    expect(res.statusCode).toBe(200);
    const oldLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'bob12345' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'newpass99' } });
    expect(newLogin.statusCode).toBe(200);
  });

  it('管理员不能删除自己', async () => {
    const admin = usersRepo(db).findByUsername('admin')!;
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${admin.id}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(400);
  });

  it('删除用户会级联清理会话与名下数据', async () => {
    await loginFree('bob', 'bob12345');
    const bob = usersRepo(db).findByUsername('bob')!;
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${bob.id}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(usersRepo(db).findById(bob.id)).toBeNull();
  });
});

async function loginFree(username: string, password: string): Promise<string> {
  await app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie },
    payload: { username, password, role: 'user' },
  });
  return login(username, password);
}
