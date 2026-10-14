import type { Database } from 'better-sqlite3';
import {
  registerEventSink,
  type SseEvent,
  type Workflow,
} from '@hustserver/engine';
import { runLogsRepo, runNodeResultsRepo, runsRepo } from './repo.js';

export type RunEventListener = (event: SseEvent) => void;

interface ActiveRun {
  runId: string;
  engineRunId: string;
  workflow: Workflow;
  startedAt: number;
  listeners: Set<RunEventListener>;
  doneListeners: Set<() => void>;
}

export interface Recorder {
  attach(runId: string, engineRunId: string, workflow: Workflow): void;
  detach(engineRunId: string): void;
  subscribe(runId: string, onEvent: RunEventListener, onDone?: () => void): (() => void) | null;
  isActive(runId: string): boolean;
  dispose(): void;
}

export function createRecorder(db: Database): Recorder {
  const runs = runsRepo(db);
  const nodeResults = runNodeResultsRepo(db);
  const logs = runLogsRepo(db);
  const byEngine = new Map<string, ActiveRun>();
  const byRun = new Map<string, ActiveRun>();

  function persist(a: ActiveRun, event: SseEvent): void {
    if ('type' in event && event.type === 'node-result') {
      const node = a.workflow.nodes.find((n) => n.id === event.nodeId);
      nodeResults.upsert({
        runId: a.runId,
        nodeId: event.nodeId,
        name: node?.name ?? null,
        kind: node?.kind ?? null,
        status: event.status,
        rowCount: event.rowCount,
        durationMs: event.durationMs,
        error: event.error ?? null,
      });
      return;
    }
    if ('type' in event && event.type === 'run-status') {
      if (event.status === 'running') {
        runs.markRunning(a.runId, a.startedAt);
        return;
      }
      const finishedAt = Date.now();
      runs.finish(a.runId, {
        status: event.status,
        finishedAt,
        durationMs: finishedAt - a.startedAt,
        error: event.status === 'error' ? event.message ?? '执行失败' : null,
      });
      return;
    }
    logs.append({
      runId: a.runId,
      ts: event.ts,
      level: event.level,
      nodeId: event.nodeId ?? null,
      message: event.message,
    });
  }

  const off = registerEventSink((ctx, event) => {
    const a = byEngine.get(ctx.runId);
    if (!a) return;
    persist(a, event);
    for (const listener of a.listeners) {
      try {
        listener(event);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  });

  return {
    attach(runId, engineRunId, workflow) {
      const a: ActiveRun = {
        runId,
        engineRunId,
        workflow,
        startedAt: Date.now(),
        listeners: new Set(),
        doneListeners: new Set(),
      };
      byEngine.set(engineRunId, a);
      byRun.set(runId, a);
      runs.markRunning(runId, a.startedAt);
    },
    detach(engineRunId) {
      const a = byEngine.get(engineRunId);
      if (!a) return;
      byEngine.delete(engineRunId);
      byRun.delete(a.runId);
      for (const done of a.doneListeners) {
        try {
          done();
        } catch {
          /* ignore */
        }
      }
      a.listeners.clear();
      a.doneListeners.clear();
    },
    subscribe(runId, onEvent, onDone) {
      const a = byRun.get(runId);
      if (!a) return null;
      a.listeners.add(onEvent);
      if (onDone) a.doneListeners.add(onDone);
      return () => {
        a.listeners.delete(onEvent);
        if (onDone) a.doneListeners.delete(onDone);
      };
    },
    isActive: (runId) => byRun.has(runId),
    dispose() {
      off();
      byEngine.clear();
      byRun.clear();
    },
  };
}
