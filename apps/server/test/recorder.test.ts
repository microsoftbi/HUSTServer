import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { publishEvent, type RunContext, type Workflow } from '@hustserver/engine';
import {
  runLogsRepo,
  runNodeResultsRepo,
  runsRepo,
} from '../src/modules/runs/repo.js';
import { createRecorder, type Recorder } from '../src/modules/runs/recorder.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO users (id,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('u1', 'admin', 'x', 'admin', 'active', 0, 0);
  db.prepare(
    'INSERT INTO workflows (id,owner_id,name,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('w1', 'u1', 'wf', '{"nodes":[],"edges":[]}', 0, 0);
  return db;
}

function fakeCtx(engineRunId: string): RunContext {
  return {
    runId: engineRunId,
    workflow: { id: 'w1', name: 'wf', nodes: [], edges: [], createdAt: 0, updatedAt: 0 },
    session: {} as RunContext['session'],
    status: 'running',
    nodeStatus: new Map(),
    nodeResults: new Map(),
    subscribers: new Set(),
    events: [],
    createdAt: 0,
    lastAccess: 0,
    ownsSession: false,
  };
}

const workflow: Workflow = {
  id: 'w1',
  name: 'wf',
  nodes: [{ id: 'n1', kind: 'select', name: '选择', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
  createdAt: 0,
  updatedAt: 0,
};

let recorder: Recorder | null = null;
afterEach(() => {
  recorder?.dispose();
  recorder = null;
});

describe('Recorder 事件落库', () => {
  it('日志、节点结果与运行状态均持久化', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'manual', triggeredBy: 'u1' });
    recorder = createRecorder(db);
    recorder.attach(run.id, 'er1', workflow);
    const ctx = fakeCtx('er1');

    publishEvent(ctx, { runId: 'er1', level: 'info', message: '开始执行', ts: 1000 });
    publishEvent(ctx, { runId: 'er1', type: 'node-result', nodeId: 'n1', status: 'running', rowCount: 0, durationMs: 0 });
    publishEvent(ctx, { runId: 'er1', type: 'node-result', nodeId: 'n1', status: 'success', rowCount: 5, durationMs: 12 });
    publishEvent(ctx, { runId: 'er1', type: 'run-status', status: 'success' });

    expect(runLogsRepo(db).listByRun(run.id, { after: 0, limit: 10 })).toHaveLength(1);

    const nodes = runNodeResultsRepo(db).listByRun(run.id);
    expect(nodes).toHaveLength(1); // upsert 后仅一行
    expect(nodes[0]).toMatchObject({ node_id: 'n1', name: '选择', kind: 'select', status: 'success', row_count: 5 });

    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('success');
    expect(detail.started_at).not.toBeNull();
    expect(detail.finished_at).not.toBeNull();
    expect(detail.duration_ms).toBeGreaterThanOrEqual(0);
    expect(detail.error).toBeNull();
  });

  it('失败运行写入 error 与 error 文案', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'schedule' });
    recorder = createRecorder(db);
    recorder.attach(run.id, 'er2', workflow);
    const ctx = fakeCtx('er2');

    publishEvent(ctx, { runId: 'er2', type: 'run-status', status: 'error', message: '上游节点未成功' });

    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe('上游节点未成功');
  });

  it('订阅者可收到事件，detach 触发 onDone', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'manual' });
    recorder = createRecorder(db);
    recorder.attach(run.id, 'er3', workflow);
    const seen: string[] = [];
    let done = false;
    recorder.subscribe(run.id, (event) => seen.push(event.runId), () => {
      done = true;
    });

    publishEvent(fakeCtx('er3'), { runId: 'er3', level: 'info', message: 'x', ts: 1 });
    expect(seen).toEqual(['er3']);
    recorder.detach('er3');
    expect(done).toBe(true);
    expect(recorder.isActive(run.id)).toBe(false);
  });

  it('已结束的运行 subscribe 返回 null', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'manual' });
    recorder = createRecorder(db);
    expect(recorder.subscribe(run.id, () => {})).toBeNull();
  });
});
