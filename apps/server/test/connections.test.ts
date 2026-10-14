import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { encryptConfig, decryptConfig, maskConnection } from '../src/modules/connections/crypto.js';

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
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');
});

describe('crypto', () => {
  it('加解密往返一致，密文不含明文', () => {
    const plain = { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'p@ss' };
    const ct = encryptConfig(plain, KEY);
    expect(ct).not.toContain('p@ss');
    expect(decryptConfig(ct, KEY)).toEqual(plain);
  });

  it('maskConnection 脱敏密码', () => {
    expect(maskConnection({ server: 'db', password: 'p@ss' })).toEqual({ server: 'db', password: '******' });
  });

  it('密钥非法时抛错', () => {
    expect(() => encryptConfig({ a: 1 }, 'short')).toThrow();
  });
});

describe('connection routes', () => {
  it('创建后列表返回脱敏配置，不泄露密码', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie },
      payload: { name: '本地库', config: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' } },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: aliceCookie } });
    expect(JSON.stringify(list.json())).not.toContain('secret');
    expect(list.json()[0].config.password).toBe('******');
  });

  it('普通用户彼此不可见；管理员共享连接对所有人可见', async () => {
    await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'a', config: { server: 'x', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const shared = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: adminCookie }, payload: { name: '公共', shared: true, config: { server: 'y', port: 1, database: 'd', user: 'u', password: 'p' } } });
    expect(shared.statusCode).toBe(201);
    const bobList = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: bobCookie } });
    expect(bobList.json()).toHaveLength(1);
    expect(bobList.json()[0].name).toBe('公共');
  });

  it('越权修改他人连接返回 403', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'a', config: { server: 'x', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const id = created.json().id;
    const res = await app.inject({ method: 'PUT', url: `/api/connections/${id}`, headers: { cookie: bobCookie }, payload: { name: 'hack' } });
    expect(res.statusCode).toBe(403);
  });

  it('连通性测试对不可达地址返回 ok=false', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'bad', config: { server: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const id = created.json().id;
    const res = await app.inject({ method: 'POST', url: `/api/connections/${id}/test`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });

  it('删除连接', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'a', config: { server: 'x', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const id = created.json().id;
    const del = await app.inject({ method: 'DELETE', url: `/api/connections/${id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
  });
});
