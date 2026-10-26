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
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
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

  it('画布主题缺省为 midnight', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect((res.json() as Record<string, unknown>).canvasTheme).toBe('midnight');
  });

  it('PUT 可取合法画布主题并持久化', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { canvasTheme: 'ocean' },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as Record<string, unknown>).canvasTheme).toBe('ocean');
    expect(settingsRepo(db).get('ui.canvasTheme')).toBe('ocean');
  });

  it('PUT 非法画布主题返回 400', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { canvasTheme: 'neon' },
    });
    expect(bad.statusCode).toBe(400);
    expect(settingsRepo(db).get('ui.canvasTheme')).toBeNull();
  });

  it('界面主题缺省为 classic，与画布主题分开存储', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect((res.json() as Record<string, unknown>).uiTheme).toBe('classic');
  });

  it('PUT 可取合法界面主题并持久化，且不影响画布主题', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { uiTheme: 'ocean' },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as Record<string, unknown>;
    expect(body.uiTheme).toBe('ocean');
    expect(settingsRepo(db).get('ui.appTheme')).toBe('ocean');
    expect(settingsRepo(db).get('ui.canvasTheme')).toBeNull();
  });

  it('PUT 非法界面主题返回 400', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { uiTheme: 'neon' },
    });
    expect(bad.statusCode).toBe(400);
    expect(settingsRepo(db).get('ui.appTheme')).toBeNull();
  });
});

describe('ui preferences route', () => {
  it('登录用户可读取当前画布与界面主题', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ui/preferences', headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ canvasTheme: 'midnight', uiTheme: 'classic' });
  });

  it('未登录返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ui/preferences' });
    expect(res.statusCode).toBe(401);
  });

  it('随系统设置变化', async () => {
    await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { canvasTheme: 'graphite', uiTheme: 'graphite' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/ui/preferences', headers: { cookie: userCookie } });
    expect(res.json()).toEqual({ canvasTheme: 'graphite', uiTheme: 'graphite' });
  });
});
