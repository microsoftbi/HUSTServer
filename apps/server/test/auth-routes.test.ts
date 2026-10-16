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

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
});

describe('auth routes', () => {
  it('正确凭据可登录并拿到 Cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual(['workflow_author']);
    expect(res.headers['set-cookie']).toContain('hs_session=');
  });

  it('错误密码返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'bad' } });
    expect(res.statusCode).toBe(401);
  });

  it('禁用账号无法登录', async () => {
    const users = usersRepo(db);
    users.update(users.findByUsername('alice')!.id, { status: 'disabled' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } });
    expect(res.statusCode).toBe(401);
  });

  it('/me 需登录，登出后失效', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } });
    const cookie = login.headers['set-cookie']!.toString().split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().username).toBe('alice');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('未登录访问 /me 返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });
});
