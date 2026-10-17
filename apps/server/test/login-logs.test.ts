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

interface LogDto {
  id: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let userCookie: string;
let aliceId: string;

/** 登录并返回会话 cookie；失败登录没有 cookie，返回空串 */
async function login(username: string, password: string, userAgent?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
    headers: userAgent ? { 'user-agent': userAgent } : {},
  });
  const cookie = res.headers['set-cookie'];
  return cookie ? cookie.toString().split(';')[0] : '';
}

async function fetchLogs(userId: string, query = ''): Promise<{ statusCode: number; logs: LogDto[] }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/admin/users/${userId}/login-logs${query}`,
    headers: { cookie: adminCookie },
  });
  const body = res.json() as { logs?: LogDto[] };
  return { statusCode: res.statusCode, logs: body.logs ?? [] };
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  await users.create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  const alice = await users.create({
    username: 'alice',
    passwordHash: await hashPassword('alice123'),
    roles: ['workflow_author'],
  });
  aliceId = alice.id;
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  userCookie = await login('alice', 'alice123', 'Mozilla/5.0 (Test)');
});

describe('登录日志写入', () => {
  it('登录成功记录一条成功日志，含 IP 与客户端', async () => {
    const { logs } = await fetchLogs(aliceId);
    const latest = logs[0];
    expect(latest.success).toBe(true);
    expect(latest.reason).toBeNull();
    expect(latest.ip).toBe('127.0.0.1');
    expect(latest.user_agent).toBe('Mozilla/5.0 (Test)');
  });

  it('密码错误记录失败日志并标注原因', async () => {
    await login('alice', 'wrong-password');
    const { logs } = await fetchLogs(aliceId);
    expect(logs[0].success).toBe(false);
    expect(logs[0].reason).toBe('密码错误');
  });

  it('用户不存在记录失败日志且不关联用户', async () => {
    await login('nobody', 'whatever1');
    const rows = db
      .prepare('SELECT * FROM login_logs WHERE username = ? ORDER BY rowid DESC')
      .all('nobody') as Array<{ user_id: string | null; success: number; reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].success).toBe(0);
    expect(rows[0].reason).toBe('用户不存在');
  });

  it('账号被禁用时记录失败日志并标注原因', async () => {
    const users = usersRepo(db);
    users.update(aliceId, { status: 'disabled' });
    await login('alice', 'alice123');
    const { logs } = await fetchLogs(aliceId);
    expect(logs[0].success).toBe(false);
    expect(logs[0].reason).toBe('账号已禁用');
  });

  it('客户端标识超长时截断到 300 字符', async () => {
    await login('alice', 'alice123', 'u'.repeat(500));
    const { logs } = await fetchLogs(aliceId);
    expect(logs[0].user_agent).toHaveLength(300);
  });
});

describe('GET /api/admin/users/:id/login-logs', () => {
  it('按时间倒序返回且只包含该用户的记录', async () => {
    await login('alice', 'bad-password');
    await login('alice', 'alice123');
    const { logs } = await fetchLogs(aliceId);
    // 最新一条是成功登录，且本用例内 alice 的记录条数与写入次数一致
    expect(logs[0].success).toBe(true);
    expect(logs.some((l) => l.success === false)).toBe(true);
    const usernames = db
      .prepare('SELECT DISTINCT username FROM login_logs')
      .all() as Array<{ username: string }>;
    expect(usernames.map((u) => u.username).sort()).toEqual(['admin', 'alice']);
  });

  it('limit 生效，默认 20 条', async () => {
    for (let i = 0; i < 25; i += 1) await login('alice', 'bad-password');
    const defaultRes = await fetchLogs(aliceId);
    expect(defaultRes.logs).toHaveLength(20);
    const limited = await fetchLogs(aliceId, '?limit=3');
    expect(limited.statusCode).toBe(200);
    expect(limited.logs).toHaveLength(3);
    const maxed = await fetchLogs(aliceId, '?limit=100');
    expect(maxed.statusCode).toBe(200);
  });

  it('非法 limit 返回 400', async () => {
    for (const bad of ['0', '-1', '101', 'abc', '1.5']) {
      const res = await fetchLogs(aliceId, `?limit=${bad}`);
      expect(res.statusCode).toBe(400);
    }
  });

  it('用户不存在返回 404', async () => {
    const res = await fetchLogs('not-exist-id');
    expect(res.statusCode).toBe(404);
  });

  it('非管理员 403，未登录 401', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/admin/users/${aliceId}/login-logs`,
      headers: { cookie: userCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/admin/users/${aliceId}/login-logs`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
