import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const KEY = 'b'.repeat(64);

let app: FastifyInstance;
let resourceDir: string;
let csvPath: string;
let cookie: string;

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password: 'alice123' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hust-schema-'));
  csvPath = path.join(resourceDir, 'demo.csv');
  fs.writeFileSync(csvPath, 'id,name\n1,alice\n2,bob\n', 'utf-8');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hust-schema-data-'));
  const db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({
    username: 'alice',
    passwordHash: await hashPassword('alice123'),
    roles: ['workflow_author'],
  });
  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: KEY,
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  cookie = await login();
});

describe('schema routes', () => {
  it('探测 CSV 列结构返回列名与类型', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/schema/csv',
      headers: { cookie },
      payload: { path: csvPath, hasHeader: true },
    });
    expect(res.statusCode).toBe(200);
    const columns = res.json().columns as Array<{ name: string; type: string }>;
    expect(columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(columns.every((c) => c.type.length > 0)).toBe(true);
  });

  it('拒绝资源库与上传目录之外的路径', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/schema/csv',
      headers: { cookie },
      payload: { path: '/etc/hosts' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('解析 CSV 失败');
  });

  it('缺少必要参数返回 400', async () => {
    const noPath = await app.inject({
      method: 'POST',
      url: '/api/schema/excel',
      headers: { cookie },
      payload: {},
    });
    expect(noPath.statusCode).toBe(400);

    const noQuery = await app.inject({
      method: 'POST',
      url: '/api/schema/sqlserver',
      headers: { cookie },
      payload: { connection: { server: 'db', database: 'd', user: 'sa' } },
    });
    expect(noQuery.statusCode).toBe(400);
    expect(noQuery.json().error).toBe('缺少查询语句');
  });

  it('未登录返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/schema/csv',
      payload: { path: csvPath },
    });
    expect(res.statusCode).toBe(401);
  });
});
