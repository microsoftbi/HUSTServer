import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { settingsRepo } from '../src/modules/settings/repo.js';

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

describe('admin settings routes', () => {
  it('普通用户访问被拒 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('未登录返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET 缺省回退 config 默认值', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.maxConcurrentRuns).toBe(cfg.maxConcurrentRuns);
    expect(body.logRetentionDays).toBe(cfg.logRetentionDays);
    expect(body.tz).toBe(cfg.tz);
    expect(Array.isArray(body.sharedDirs)).toBe(true);
  });

  it('PUT 持久化并覆盖默认值', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { maxConcurrentRuns: 5, logRetentionDays: 30, sharedDirs: ['/data/a'], tz: 'UTC' },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as Record<string, unknown>).maxConcurrentRuns).toBe(5);

    const repo = settingsRepo(db);
    expect(repo.get('maxConcurrentRuns')).toBe('5');
    expect(JSON.parse(repo.get('sharedDirs')!)).toEqual(['/data/a']);

    const get = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    const body = get.json() as Record<string, unknown>;
    expect(body.sharedDirs).toEqual(['/data/a']);
    expect(body.tz).toBe('UTC');
  });

  it('PUT 校验失败返回 400', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { maxConcurrentRuns: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
