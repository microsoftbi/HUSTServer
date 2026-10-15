import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { NodeRunStatus } from '@hustserver/engine';

export type RunStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';
export type TriggerType = 'manual' | 'schedule' | 'job';
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface RunRow {
  id: string;
  workflow_id: string;
  schedule_id: string | null;
  trigger_type: TriggerType;
  triggered_by: string | null;
  status: RunStatus;
  engine_run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
  job_run_id: string | null;
}

export interface RunNodeResultRow {
  id: number;
  run_id: string;
  node_id: string;
  name: string | null;
  kind: string | null;
  status: NodeRunStatus;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  updated_at: number;
}

export interface RunLogRow {
  id: number;
  run_id: string;
  ts: number;
  level: LogLevel;
  node_id: string | null;
  message: string;
}

export interface RunsRepo {
  create(input: {
    workflowId: string;
    scheduleId?: string | null;
    triggerType: TriggerType;
    triggeredBy?: string | null;
    status?: RunStatus;
    jobRunId?: string | null;
  }): RunRow;
  findById(id: string): RunRow | null;
  listByWorkflow(workflowId: string, opts: { limit: number; offset: number }): RunRow[];
  countByWorkflow(workflowId: string): number;
  listOlderThan(cutoff: number): RunRow[];
  setEngineRunId(id: string, engineRunId: string): void;
  markRunning(id: string, startedAt: number): void;
  finish(
    id: string,
    patch: { status: RunStatus; finishedAt: number; durationMs: number | null; error: string | null },
  ): void;
  remove(id: string): boolean;
}

export function runsRepo(db: Database): RunsRepo {
  const getStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO runs (id,workflow_id,schedule_id,trigger_type,triggered_by,status,engine_run_id,started_at,finished_at,duration_ms,error,created_at,job_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const listStmt = db.prepare(
    'SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE workflow_id = ?');
  const olderStmt = db.prepare('SELECT * FROM runs WHERE created_at < ? ORDER BY created_at ASC');
  const setEngineStmt = db.prepare('UPDATE runs SET engine_run_id = ? WHERE id = ?');
  const markRunningStmt = db.prepare(
    "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
  );
  const finishStmt = db.prepare(
    'UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, error = ? WHERE id = ?',
  );
  const deleteStmt = db.prepare('DELETE FROM runs WHERE id = ?');
  const get = (id: string): RunRow | null => (getStmt.get(id) as RunRow | undefined) ?? null;

  return {
    create({ workflowId, scheduleId = null, triggerType, triggeredBy = null, status = 'queued', jobRunId = null }) {
      const id = nanoid(12);
      insertStmt.run(id, workflowId, scheduleId, triggerType, triggeredBy, status, null, null, null, null, null, Date.now(), jobRunId);
      return get(id)!;
    },
    findById: get,
    listByWorkflow: (workflowId, { limit, offset }) =>
      listStmt.all(workflowId, limit, offset) as RunRow[],
    countByWorkflow: (workflowId) => Number((countStmt.get(workflowId) as { c: number }).c),
    listOlderThan: (cutoff) => olderStmt.all(cutoff) as RunRow[],
    setEngineRunId: (id, engineRunId) => {
      setEngineStmt.run(engineRunId, id);
    },
    markRunning: (id, startedAt) => {
      markRunningStmt.run(startedAt, id);
    },
    finish: (id, patch) => {
      finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error, id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
  };
}

export interface RunNodeResultsRepo {
  upsert(input: {
    runId: string;
    nodeId: string;
    name?: string | null;
    kind?: string | null;
    status: NodeRunStatus;
    rowCount?: number | null;
    durationMs?: number | null;
    error?: string | null;
    updatedAt?: number;
  }): void;
  listByRun(runId: string): RunNodeResultRow[];
}

export function runNodeResultsRepo(db: Database): RunNodeResultsRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO run_node_results (run_id,node_id,name,kind,status,row_count,duration_ms,error,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id,node_id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       status = excluded.status,
       row_count = excluded.row_count,
       duration_ms = excluded.duration_ms,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  );
  const listStmt = db.prepare('SELECT * FROM run_node_results WHERE run_id = ? ORDER BY id ASC');
  return {
    upsert(input) {
      upsertStmt.run(
        input.runId,
        input.nodeId,
        input.name ?? null,
        input.kind ?? null,
        input.status,
        input.rowCount ?? null,
        input.durationMs ?? null,
        input.error ?? null,
        input.updatedAt ?? Date.now(),
      );
    },
    listByRun: (runId) => listStmt.all(runId) as RunNodeResultRow[],
  };
}

export interface RunLogsRepo {
  append(input: { runId: string; ts: number; level: LogLevel; nodeId?: string | null; message: string }): number;
  listByRun(runId: string, opts?: { after?: number; limit?: number }): RunLogRow[];
  countByRun(runId: string): number;
}

export function runLogsRepo(db: Database): RunLogsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO run_logs (run_id,ts,level,node_id,message) VALUES (?,?,?,?,?)',
  );
  const listStmt = db.prepare(
    'SELECT * FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM run_logs WHERE run_id = ?');
  return {
    append({ runId, ts, level, nodeId = null, message }) {
      return Number(insertStmt.run(runId, ts, level, nodeId, message).lastInsertRowid);
    },
    listByRun: (runId, opts = {}) =>
      listStmt.all(runId, opts.after ?? 0, opts.limit ?? 1000) as RunLogRow[],
    countByRun: (runId) => Number((countStmt.get(runId) as { c: number }).c),
  };
}
