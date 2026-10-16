import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const KEY = 'b'.repeat(64);
const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: KEY, HUSTSERVER_DATA_DIR: '/tmp/hustserver-test' });

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

async function createConnection(cookie: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/connections', headers: { cookie },
    payload: { name: '测试库', config: { server: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' } },
  });
  return res.json().id as string;
}

describe('POST /api/data/query', () => {
  it('未登录 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/data/query', payload: {} })).statusCode).toBe(401);
  });
  it('缺少 connectionId 400 / 缺少 SQL 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: aliceCookie }, payload: { query: 'SELECT 1' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: aliceCookie }, payload: { connectionId: 'x' } })).statusCode).toBe(400);
  });
  it('连接不存在 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: aliceCookie }, payload: { connectionId: 'nope', query: 'SELECT 1' } });
    expect(res.statusCode).toBe(404);
  });
  it('他人未共享连接 403', async () => {
    const id = await createConnection(aliceCookie);
    const res = await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: bobCookie }, payload: { connectionId: id, query: 'SELECT 1' } });
    expect(res.statusCode).toBe(403);
  });
  it('共享连接：SQL 执行失败 → 400 执行 SQL 失败（连不上 127.0.0.1:1）', async () => {
    const id = await createConnection(aliceCookie);
    await app.inject({ method: 'PUT', url: `/api/connections/${id}`, headers: { cookie: adminCookie }, payload: { shared: true } });
    const res = await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: bobCookie }, payload: { connectionId: id, query: 'SELECT 1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('执行 SQL 失败');
    expect(typeof res.json().detail).toBe('string');
  });
});
