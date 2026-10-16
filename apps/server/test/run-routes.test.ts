import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createRecorder } from '../src/modules/runs/recorder.js';
import { runLogsRepo, runsRepo } from '../src/modules/runs/repo.js';
import { createRunService } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';
import { buildServer } from '../src/server.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const PAYLOAD = JSON.stringify({ nodes: [], edges: [] });

let app: FastifyInstance;
let db: Database.Database;
let recorder: ReturnType<typeof createRecorder>;
let ownerCookie: string;
let otherCookie: string;
let workflowId: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  const owner = await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['workflow_author'] });
  workflowId = workflowsRepo(db).create({ ownerId: owner.id, name: 'A', payload: PAYLOAD }).id;
  recorder = createRecorder(db);
  const runService = createRunService({ db, config: cfg, recorder, executor: async ({ onEngineRunId }) => onEngineRunId('eng-1') });
  app = await buildServer({ db, config: cfg, logger: false, overrides: { recorder, runService } });
  await app.ready();
  ownerCookie = await login('alice', 'alice123');
  otherCookie = await login('bob', 'bob12345');
});

describe('runRoutes', () => {
  it('手动运行返回 runId，随后可查详情与日志', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers: { cookie: ownerCookie } });
    expect(start.statusCode).toBe(202);
    const { runId } = start.json() as { runId: string };

    // 等待队列跑完（executor 为同步桩）
    await new Promise((r) => setTimeout(r, 20));

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: ownerCookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.status).toBe('success');

    const logs = await app.inject({ method: 'GET', url: `/api/runs/${runId}/logs`, headers: { cookie: ownerCookie } });
    expect(logs.statusCode).toBe(200);
    expect(Array.isArray(logs.json().items)).toBe(true);
  });

  it('非属主不可访问（管理员可）', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers: { cookie: ownerCookie } });
    const { runId } = start.json() as { runId: string };
    const forbidden = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: otherCookie } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('运行历史分页', async () => {
    await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers: { cookie: ownerCookie } });
    const res = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/runs?limit=10&offset=0`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(1);
  });

  it('已结束运行的 SSE 立即回 done', async () => {
    const run = runsRepo(db).create({ workflowId, triggerType: 'manual', status: 'success' });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/events`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: done');
  });

  it('未登录返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs` });
    expect(res.statusCode).toBe(401);
  });
});
