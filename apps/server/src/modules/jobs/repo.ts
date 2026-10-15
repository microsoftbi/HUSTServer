import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { FreqType } from '../schedules/cron.js';

export type JobStepType = 'workflow' | 'sql';
export type JobOnFailure = 'abort' | 'continue';
export type JobRunStatus = 'queued' | 'running' | 'success' | 'error';
export type JobStepRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface JobRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  enabled: number;
  freq_type: FreqType | null;
  cron_expr: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
}

export interface JobStepRow {
  id: string;
  job_id: string;
  seq: number;
  type: JobStepType;
  name: string;
  config: string;
  on_failure: JobOnFailure;
  created_at: number;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  trigger_type: 'manual' | 'schedule';
  triggered_by: string | null;
  status: JobRunStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

export interface JobStepRunRow {
  id: string;
  job_run_id: string;
  step_id: string | null;
  seq: number;
  type: JobStepType;
  name: string;
  config: string;
  on_failure: JobOnFailure;
  status: JobStepRunStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  output: string | null;
  created_at: number;
}

export interface JobStepInput {
  type: JobStepType;
  name: string;
  config: string;
  onFailure: JobOnFailure;
}

export interface JobsRepo {
  create(input: {
    ownerId: string;
    name: string;
    description: string | null;
    enabled: boolean;
    freqType: FreqType | null;
    cronExpr: string | null;
    timezone: string;
    steps: JobStepInput[];
  }): JobRow;
  update(
    id: string,
    input: {
      name: string;
      description: string | null;
      enabled: boolean;
      freqType: FreqType | null;
      cronExpr: string | null;
      timezone: string;
      steps: JobStepInput[];
    },
  ): JobRow | null;
  findById(id: string): JobRow | null;
  listForOwner(ownerId: string): JobRow[];
  listAll(): JobRow[];
  listEnabledScheduled(): JobRow[];
  remove(id: string): boolean;
  listSteps(jobId: string): JobStepRow[];
}

export function jobsRepo(db: Database): JobsRepo {
  const getStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const insertJobStmt = db.prepare(
    'INSERT INTO jobs (id,owner_id,name,description,enabled,freq_type,cron_expr,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const updateJobStmt = db.prepare(
    'UPDATE jobs SET name=?,description=?,enabled=?,freq_type=?,cron_expr=?,timezone=?,updated_at=? WHERE id=?',
  );
  const insertStepStmt = db.prepare(
    'INSERT INTO job_steps (id,job_id,seq,type,name,config,on_failure,created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const deleteStepsStmt = db.prepare('DELETE FROM job_steps WHERE job_id = ?');
  const ownerStmt = db.prepare('SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC');
  const allStmt = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC');
  const enabledScheduledStmt = db.prepare(
    "SELECT * FROM jobs WHERE enabled = 1 AND cron_expr IS NOT NULL AND cron_expr != ''",
  );
  const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  const stepsStmt = db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq ASC');
  const get = (id: string): JobRow | null => (getStmt.get(id) as JobRow | undefined) ?? null;
  const getSteps = (jobId: string): JobStepRow[] => stepsStmt.all(jobId) as JobStepRow[];

  const writeSteps = (jobId: string, steps: JobStepInput[], now: number): void => {
    deleteStepsStmt.run(jobId);
    steps.forEach((s, i) => {
      insertStepStmt.run(nanoid(12), jobId, i, s.type, s.name, s.config, s.onFailure, now);
    });
  };

  return {
    create(input) {
      const id = nanoid(12);
      const now = Date.now();
      db.transaction(() => {
        insertJobStmt.run(
          id, input.ownerId, input.name, input.description, input.enabled ? 1 : 0,
          input.freqType, input.cronExpr, input.timezone, now, now,
        );
        writeSteps(id, input.steps, now);
      })();
      return get(id)!;
    },
    update(id, input) {
      const cur = get(id);
      if (!cur) return null;
      const now = Date.now();
      db.transaction(() => {
        updateJobStmt.run(
          input.name, input.description, input.enabled ? 1 : 0,
          input.freqType, input.cronExpr, input.timezone, now, id,
        );
        writeSteps(id, input.steps, now);
      })();
      return get(id);
    },
    findById: get,
    listForOwner: (ownerId) => ownerStmt.all(ownerId) as JobRow[],
    listAll: () => allStmt.all() as JobRow[],
    listEnabledScheduled: () => enabledScheduledStmt.all() as JobRow[],
    remove: (id) => deleteJobStmt.run(id).changes > 0,
    listSteps: getSteps,
  };
}

export interface JobRunsRepo {
  create(input: { jobId: string; triggerType: 'manual' | 'schedule'; triggeredBy: string | null }): JobRunRow;
  findById(id: string): JobRunRow | null;
  markRunning(id: string, startedAt: number): void;
  finish(id: string, patch: { status: JobRunStatus; finishedAt: number; durationMs: number | null; error: string | null }): void;
  listByJob(jobId: string, opts: { limit: number; offset: number }): JobRunRow[];
  countByJob(jobId: string): number;
}

export function jobRunsRepo(db: Database): JobRunsRepo {
  const getStmt = db.prepare('SELECT * FROM job_runs WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO job_runs (id,job_id,trigger_type,triggered_by,status,started_at,finished_at,duration_ms,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const markRunningStmt = db.prepare("UPDATE job_runs SET status='running', started_at=? WHERE id=?");
  const finishStmt = db.prepare('UPDATE job_runs SET status=?, finished_at=?, duration_ms=?, error=? WHERE id=?');
  const listStmt = db.prepare('SELECT * FROM job_runs WHERE job_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM job_runs WHERE job_id=?');
  const get = (id: string): JobRunRow | null => (getStmt.get(id) as JobRunRow | undefined) ?? null;
  return {
    create({ jobId, triggerType, triggeredBy }) {
      const id = nanoid(12);
      insertStmt.run(id, jobId, triggerType, triggeredBy, 'queued', null, null, null, null, Date.now());
      return get(id)!;
    },
    findById: get,
    markRunning: (id, startedAt) => markRunningStmt.run(startedAt, id),
    finish: (id, patch) => finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error, id),
    listByJob: (jobId, { limit, offset }) => listStmt.all(jobId, limit, offset) as JobRunRow[],
    countByJob: (jobId) => Number((countStmt.get(jobId) as { c: number }).c),
  };
}

export interface JobStepRunsRepo {
  createBatch(
    jobRunId: string,
    steps: Array<{ stepId: string | null; seq: number; type: JobStepType; name: string; config: string; onFailure: JobOnFailure }>,
  ): void;
  listByJobRun(jobRunId: string): JobStepRunRow[];
  markRunning(id: string, startedAt: number): void;
  finish(id: string, patch: { status: JobStepRunStatus; finishedAt: number; durationMs: number | null; error?: string | null; output?: string | null }): void;
  /** 把从 fromSeq 起的所有 pending 步骤标记为 skipped。 */
  skipRemaining(jobRunId: string, fromSeq: number): void;
  findById(id: string): JobStepRunRow | null;
}

export function jobStepRunsRepo(db: Database): JobStepRunsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO job_step_runs (id,job_run_id,step_id,seq,type,name,config,on_failure,status,started_at,finished_at,duration_ms,error,output,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const listStmt = db.prepare('SELECT * FROM job_step_runs WHERE job_run_id=? ORDER BY seq ASC');
  const markRunningStmt = db.prepare("UPDATE job_step_runs SET status='running', started_at=? WHERE id=?");
  const finishStmt = db.prepare('UPDATE job_step_runs SET status=?, finished_at=?, duration_ms=?, error=?, output=? WHERE id=?');
  const skipStmt = db.prepare(
    "UPDATE job_step_runs SET status='skipped', finished_at=? WHERE job_run_id=? AND seq>=? AND status='pending'",
  );
  const getStmt = db.prepare('SELECT * FROM job_step_runs WHERE id=?');
  const get = (id: string): JobStepRunRow | null => (getStmt.get(id) as JobStepRunRow | undefined) ?? null;
  return {
    createBatch(jobRunId, steps) {
      const now = Date.now();
      db.transaction(() => {
        for (const s of steps) {
          insertStmt.run(nanoid(12), jobRunId, s.stepId, s.seq, s.type, s.name, s.config, s.onFailure, 'pending', null, null, null, null, null, now);
        }
      })();
    },
    listByJobRun: (jobRunId) => listStmt.all(jobRunId) as JobStepRunRow[],
    markRunning: (id, startedAt) => markRunningStmt.run(startedAt, id),
    finish: (id, patch) =>
      finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error ?? null, patch.output ?? null, id),
    skipRemaining: (jobRunId, fromSeq) => skipStmt.run(Date.now(), jobRunId, fromSeq),
    findById: get,
  };
}
