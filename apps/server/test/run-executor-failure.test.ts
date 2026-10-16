import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 模拟 vendored 引擎的真实行为：executeWorkflow 在节点失败时**正常 resolve**
 * （不抛异常），仅在 RunContext 上置 status='error' 并写入失败节点结果。
 * 这正是被掩盖的路径 —— defaultExecutor 需要据此把失败交回 worker 的重试语义。
 */
const h = vi.hoisted(() => ({
  runs: new Map<string, { runId: string; status: string; nodeResults: Map<string, unknown> }>(),
  seq: { n: 0 },
}));

vi.mock('@hustserver/engine', async (importActual) => {
  const actual = await importActual<typeof import('@hustserver/engine')>();
  return {
    ...actual,
    createRun: vi.fn(async (workflow: unknown) => {
      h.seq.n += 1;
      const ctx = {
        runId: `eng-${h.seq.n}`,
        workflow,
        status: 'running',
        nodeResults: new Map<string, unknown>(),
      };
      h.runs.set(ctx.runId, ctx);
      return ctx;
    }),
    executeWorkflow: vi.fn(async (runId: string) => {
      const ctx = h.runs.get(runId);
      if (!ctx) return;
      // 节点失败：仅置状态与结果，正常返回（与 executor.ts 主流程一致）。
      ctx.status = 'error';
      ctx.nodeResults.set('n1', {
        status: 'error',
        rowCount: 0,
        durationMs: 0,
        error: '节点失败：文件不存在',
      });
    }),
    getRun: vi.fn((runId: string) => h.runs.get(runId) ?? null),
  };
});

import { createRun, executeWorkflow } from '@hustserver/engine';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createRecorder } from '../src/modules/runs/recorder.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import { createRunService } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const PAYLOAD = JSON.stringify({
  nodes: [{ id: 'n1', kind: 'inputCsv', name: 'A', position: { x: 0, y: 0 }, config: { path: '/o/a.csv' } }],
  edges: [],
});

let db: Database.Database;
let workflowId: string;

beforeEach(() => {
  h.runs.clear();
  h.seq.n = 0;
  db = new Database(':memory:');
  migrate(db);
  const owner = usersRepo(db).create({ username: 'alice', passwordHash: 'x', roles: ['workflow_author'] });
  workflowId = workflowsRepo(db).create({ ownerId: owner.id, name: 'A', payload: PAYLOAD }).id;
});

describe('defaultExecutor 失败语义', () => {
  it('引擎正常返回但状态为 error 时：运行记为 error、保留失败原因并按 runMaxRetries 重试', async () => {
    const recorder = createRecorder(db);
    const service = createRunService({ db, config: cfg, recorder });

    const run = service.trigger(workflowId, { triggerType: 'manual' });
    await service.whenIdle();

    const detail = runsRepo(db).findById(run.id)!;
    // 1) 不得被误记为 success，且失败原因来自失败节点（而非空）。
    expect(detail.status).toBe('error');
    expect(detail.error).toBe('节点失败：文件不存在');
    expect(detail.finished_at).not.toBeNull();
    // 节点结果与运行状态自洽。
    expect(detail.status).not.toBe('success');

    // 2) 失败重试确实发生：尝试次数 = runMaxRetries + 1。
    expect(vi.mocked(createRun).mock.calls.length).toBe(cfg.runMaxRetries + 1);
    expect(vi.mocked(executeWorkflow).mock.calls.length).toBe(cfg.runMaxRetries + 1);

    recorder.dispose();
  });
});
