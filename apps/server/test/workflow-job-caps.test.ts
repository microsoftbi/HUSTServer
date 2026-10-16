import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-wf-job-caps-'));
const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
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

const emptyWorkflow = {
  id: 'w',
  name: '样例',
  createdAt: 0,
  updatedAt: 0,
  nodes: [] as unknown[],
  edges: [] as unknown[],
};

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

describe('workflow 与 Job 模块能力门禁', () => {
  it('workflow_author 可创建工作流（201）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { cookie: wfCookie },
      payload: { workflow: emptyWorkflow, mappings: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().id).toBe('string');
  });

  it('查看与创建工作流需要「工作流」权限（403）', async () => {
    for (const cookie of [viewerCookie, dashAuthorCookie]) {
      const list = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie } });
      expect(list.statusCode).toBe(403);
      expect(list.json().error).toBe('需要「工作流」权限');

      const create = await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: { cookie },
        payload: { workflow: emptyWorkflow, mappings: [] },
      });
      expect(create.statusCode).toBe(403);
      expect(create.json().error).toBe('需要「工作流」权限');
    }
  });

  it('Job 编排端点在 workflow_author 下可用（200）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: wfCookie } });
    expect(res.statusCode).toBe(200);
  });

  it('jobs / runs / schedules 需要「Job 编排」权限（403）', async () => {
    for (const cookie of [viewerCookie, dashAuthorCookie]) {
      const endpoints = [
        { method: 'GET' as const, url: '/api/jobs' },
        { method: 'GET' as const, url: '/api/runs/some-run-id' },
        { method: 'GET' as const, url: '/api/workflows/nonexistent/schedules' },
      ];
      for (const endpoint of endpoints) {
        const res = await app.inject({ ...endpoint, headers: { cookie } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('需要「Job 编排」权限');
      }
    }
  });
});
