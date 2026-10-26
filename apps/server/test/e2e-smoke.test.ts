import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBootstrapAdmin } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo } from '../src/modules/jobs/repo.js';
import type { JobService } from '../src/modules/jobs/service.js';
import { createRecorder, type Recorder } from '../src/modules/runs/recorder.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { buildServer } from '../src/server.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hustserver-e2e-'));

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
  BOOTSTRAP_ADMIN_USER: 'root',
  BOOTSTRAP_ADMIN_PASSWORD: 'root12345',
});

/** 从 inject 响应中取出会话 Cookie 的 name=value 部分。 */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return value.split(';')[0];
}

describe('端到端冒烟：建号 → 工作流 → 调度 → 运行 → 设置权限', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let adminCookie = '';
  let userCookie = '';
  let workflowId = '';
  let stubScheduler: Scheduler;
  let stubJobScheduler: Scheduler;

  beforeAll(async () => {
    db = new Database(path.join(dataDir, 'e2e.sqlite'));
    db.pragma('foreign_keys = ON');
    migrate(db);
    await ensureBootstrapAdmin(db, cfg, { info() {}, warn() {} });

    // 注入桩：真实 recorder（无原生依赖）+ 直接落库的 runService（不拉起 DuckDB）+ 空 scheduler（不起真实定时器）
    const recorder: Recorder = createRecorder(db);
    const runService: RunService = {
      trigger(workflowIdArg, opts) {
        return runsRepo(db).create({
          workflowId: workflowIdArg,
          scheduleId: opts?.scheduleId ?? null,
          triggerType: opts?.triggerType ?? 'manual',
          triggeredBy: opts?.triggeredBy ?? null,
          status: 'success',
        });
      },
      async whenIdle() {},
    };
    stubScheduler = { start() {}, stop() {}, sync() {}, registeredIds: () => [] } as unknown as Scheduler;
    stubJobScheduler = { start() {}, stop() {}, sync() {}, registeredIds: () => [] } as unknown as Scheduler;
    const stubJobService: JobService = {
      trigger(jobId, opts) {
        const jobRun = jobRunsRepo(db).create({
          jobId, triggerType: opts?.triggerType ?? 'manual', triggeredBy: opts?.triggeredBy ?? null,
        });
        const steps = jobsRepo(db).listNodes(jobId);
        jobStepRunsRepo(db).createBatch(jobRun.id, steps.map((s) => ({
          stepId: s.id, nodeKey: s.node_key ?? s.id, seq: s.seq,
          type: s.type, name: s.name, config: s.config, onFailure: s.on_failure,
        })));
        for (const s of jobStepRunsRepo(db).listByJobRun(jobRun.id)) {
          jobStepRunsRepo(db).finish(s.id, { status: 'success', finishedAt: Date.now(), durationMs: 0 });
        }
        jobRunsRepo(db).finish(jobRun.id, { status: 'success', finishedAt: Date.now(), durationMs: 0, error: null });
        return jobRunsRepo(db).findById(jobRun.id)!;
      },
      async whenIdle() {},
    };

    app = await buildServer({
      db,
      config: cfg,
      overrides: { recorder, runService, scheduler: stubScheduler, jobService: stubJobService, jobScheduler: stubJobScheduler },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'root12345' },
    });
    expect(login.statusCode).toBe(200);
    adminCookie = cookieFrom(login);
  });

  afterAll(async () => {
    await app.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('buildServer 暴露注入的 scheduler 装饰器', () => {
    expect(app.scheduler).toBe(stubScheduler);
  });

  it('管理员创建普通用户', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { username: 'alice', password: 'password1', roles: ['workflow_author'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('普通用户登录并完成连接/工作流/调度/运行闭环', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'password1' },
    });
    expect(login.statusCode).toBe(200);
    userCookie = cookieFrom(login);

    const conn = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie: userCookie },
      payload: {
        name: '本地库',
        config: { server: '127.0.0.1', port: 1433, database: 'demo', user: 'sa', password: 'p' },
      },
    });
    expect(conn.statusCode).toBe(201);

    const workflow = {
      id: 'wf-e2e',
      name: '订单清洗',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'n1', kind: 'inputCsv', name: '读取订单', position: { x: 0, y: 0 }, config: { path: '/data/orders.csv' } },
        { id: 'n2', kind: 'outputCsv', name: '导出结果', position: { x: 200, y: 0 }, config: { path: '/data/out.csv' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { cookie: userCookie },
      payload: { name: '订单清洗', workflow, mappings: [] },
    });
    expect(created.statusCode).toBe(201);
    workflowId = (created.json() as { id: string }).id;

    const list = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: userCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json() as Array<{ name: string }>).toHaveLength(1);

    const schedule = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: userCookie },
      payload: { freqType: 'daily', time: '08:30', timezone: 'Asia/Shanghai' },
    });
    expect(schedule.statusCode).toBe(201);
    expect(typeof (schedule.json() as { nextRunAt: number }).nextRunAt).toBe('number');

    const started = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/runs`,
      headers: { cookie: userCookie },
    });
    expect(started.statusCode).toBe(202);
    const runId = (started.json() as { runId: string }).runId;

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: userCookie } });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { run: { status: string } }).run.status).toBe('success');
  });

  it('系统设置仅管理员可读写', async () => {
    const adminGet = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect(adminGet.statusCode).toBe(200);

    const adminPut = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: adminCookie },
      payload: { maxConcurrentRuns: 3, logRetentionDays: 30, tz: 'Asia/Shanghai' },
    });
    expect(adminPut.statusCode).toBe(200);
    expect((adminPut.json() as { maxConcurrentRuns: number }).maxConcurrentRuns).toBe(3);

    const userGet = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: userCookie } });
    expect(userGet.statusCode).toBe(403);
  });

  it('Job 编排闭环：创建 → 手动运行 → 查看步骤结果', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: userCookie },
      payload: {
        name: '日结', steps: [{ type: 'workflow', name: '跑清洗', workflowId, onFailure: 'abort' }],
        schedule: { enabled: true, freqType: 'daily', time: '07:30' },
      },
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json() as { id: string }).id;

    const started = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/runs`, headers: { cookie: userCookie } });
    expect(started.statusCode).toBe(202);
    const jobRunId = (started.json() as { jobRunId: string }).jobRunId;

    const detail = await app.inject({ method: 'GET', url: `/api/job-runs/${jobRunId}`, headers: { cookie: userCookie } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { jobRun: { status: string }; steps: Array<{ status: string }> };
    expect(body.jobRun.status).toBe('success');
    expect(body.steps.map((s) => s.status)).toEqual(['success']);
  });
});
