import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRetention,
  pruneRuns,
  type RetentionDeps,
} from '../src/modules/runs/retention.js';
import type { RunRow } from '../src/modules/runs/repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function row(id: string, createdAt: number): RunRow {
  return {
    id,
    workflow_id: 'wf1',
    schedule_id: null,
    trigger_type: 'manual',
    triggered_by: null,
    status: 'success',
    engine_run_id: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error: null,
    created_at: createdAt,
  };
}

function stubRuns(rows: RunRow[]) {
  const removed: string[] = [];
  const listOlderThan = vi.fn((cutoff: number) => rows.filter((r) => r.created_at < cutoff));
  const remove = vi.fn((id: string) => {
    removed.push(id);
    return true;
  });
  return {
    repo: {
      create: vi.fn(),
      findById: vi.fn(),
      listByWorkflow: vi.fn(),
      countByWorkflow: vi.fn(),
      listOlderThan,
      setEngineRunId: vi.fn(),
      markRunning: vi.fn(),
      finish: vi.fn(),
      remove,
    },
    listOlderThan,
    remove,
    removed,
  };
}

describe('pruneRuns', () => {
  it('删除超过保留期的运行并保留新运行', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const { repo, removed } = stubRuns([
      row('old', now - 100 * DAY_MS),
      row('edge', now - 89 * DAY_MS),
      row('fresh', now - 1 * DAY_MS),
    ]);
    const deps: RetentionDeps = { runs: repo as never, logRetentionDays: 90, now: () => now };

    expect(pruneRuns(deps)).toBe(1);
    expect(removed).toEqual(['old']);
  });

  it('按 logRetentionDays 计算截止时间', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const { repo, listOlderThan } = stubRuns([]);
    const deps: RetentionDeps = { runs: repo as never, logRetentionDays: 30, now: () => now };

    pruneRuns(deps);
    expect(listOlderThan).toHaveBeenCalledWith(now - 30 * DAY_MS);
  });
});

describe('createRetention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('run 返回删除数量', () => {
    const now = Date.now();
    const { repo } = stubRuns([row('old', now - 100 * DAY_MS)]);
    const retention = createRetention({ runs: repo as never, logRetentionDays: 90, now: () => now });

    expect(retention.run()).toBe(1);
  });

  it('start 后按间隔触发清理', () => {
    const now = Date.now();
    const { repo, remove } = stubRuns([row('old', now - 100 * DAY_MS)]);
    const retention = createRetention({
      runs: repo as never,
      logRetentionDays: 90,
      now: () => now,
      intervalMs: 1000,
    });

    retention.start();
    vi.advanceTimersByTime(3000);
    expect(remove).toHaveBeenCalledTimes(3);
    retention.stop();
  });

  it('stop 后不再触发', () => {
    const now = Date.now();
    const { repo, remove } = stubRuns([row('old', now - 100 * DAY_MS)]);
    const retention = createRetention({
      runs: repo as never,
      logRetentionDays: 90,
      now: () => now,
      intervalMs: 1000,
    });

    retention.start();
    vi.advanceTimersByTime(1000);
    retention.stop();
    vi.advanceTimersByTime(5000);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('清理出错时交 onError 且不抛出', () => {
    const onError = vi.fn();
    const failing = { listOlderThan: () => { throw new Error('boom'); } };
    const retention = createRetention({
      runs: failing as never,
      logRetentionDays: 90,
      onError,
    });

    expect(() => retention.run()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
