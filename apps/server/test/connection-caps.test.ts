import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

let app: FastifyInstance;
let db: Database.Database;
let viewerCookie: string;
let dashAuthorCookie: string;
let wfCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'viewer', passwordHash: await hashPassword('viewer123'), roles: ['dashboard_viewer'] });
  await usersRepo(db).create({ username: 'dashAuthor', passwordHash: await hashPassword('dash12345'), roles: ['dashboard_author'] });
  await usersRepo(db).create({ username: 'wf', passwordHash: await hashPassword('wf123456'), roles: ['workflow_author'] });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  viewerCookie = await login('viewer', 'viewer123');
  dashAuthorCookie = await login('dashAuthor', 'dash12345');
  wfCookie = await login('wf', 'wf123456');
});

describe('connections 管理/使用能力门禁', () => {
  it('viewer 无 connection.use，GET /api/connections 403「连接使用」', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: viewerCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('需要「连接使用」权限');
  });

  it('dashboard_author 有 connection.use 可列表，但无 connection.manage 不能创建', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: dashAuthorCookie } });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie: dashAuthorCookie },
      payload: { name: 'c1', type: 'sqlserver', config: { server: 'localhost' } },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error).toBe('需要「连接管理」权限');
  });

  it('workflow_author 有 connection.manage 可创建（201）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie: wfCookie },
      payload: { name: 'c1', type: 'sqlserver', config: { server: 'localhost' } },
    });
    expect(res.statusCode).toBe(201);
  });
});
