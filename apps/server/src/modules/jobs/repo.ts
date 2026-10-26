import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { FreqType } from '../schedules/cron.js';

export type JobStepType = 'workflow' | 'sql' | 'load_model';
export type JobOnFailure = 'abort' | 'continue';
/** run：正常执行；skip：只跳过自身，下游继续；disable：自身与全部可达下游都不执行 */
export type JobNodeMode = 'run' | 'skip' | 'disable';
export type JobRunStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';
export type JobStepRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'canceled';

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
  node_key: string | null;
  pos_x: number;
  pos_y: number;
  run_mode: JobNodeMode;
  created_at: number;
}

export interface JobEdgeRow {
  id: string;
  job_id: string;
  source_key: string;
  target_key: string;
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
  graph_snapshot: string | null;
  created_at: number;
}

export interface JobStepRunRow {
  id: string;
  job_run_id: string;
  step_id: string | null;
  node_key: string | null;
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

export interface JobNodeInput {
  key: string;
  type: JobStepType;
  name: string;
  config: string;
  onFailure: JobOnFailure;
  mode: JobNodeMode;
  x: number;
  y: number;
}

export interface JobEdgeInput {
  source: string;
  target: string;
}

/** 运行快照中的节点：配置平铺为对象，与 GET 详情的 nodes 一致。 */
export interface JobGraphNodeSnapshot {
  key: string;
  seq: number;
  type: JobStepType;
  name: string;
  onFailure: JobOnFailure;
  mode: JobNodeMode;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

/** 写入 job_runs.graph_snapshot 的图快照，保证运行期间编辑 Job 不影响本次执行。 */
export interface JobGraphSnapshot {
  version: 1;
  nodes: JobGraphNodeSnapshot[];
  edges: JobEdgeInput[];
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
    nodes: JobNodeInput[];
    edges: JobEdgeInput[];
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
      nodes: JobNodeInput[];
      edges: JobEdgeInput[];
    },
  ): JobRow | null;
  findById(id: string): JobRow | null;
  listForOwner(ownerId: string): JobRow[];
  listAll(): JobRow[];
  listEnabledScheduled(): JobRow[];
  remove(id: string): boolean;
  listNodes(jobId: string): JobStepRow[];
  listEdges(jobId: string): JobEdgeRow[];
}

export function jobsRepo(db: Database): JobsRepo {
  const getStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const insertJobStmt = db.prepare(
    'INSERT INTO jobs (id,owner_id,name,description,enabled,freq_type,cron_expr,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const updateJobStmt = db.prepare(
    'UPDATE jobs SET name=?,description=?,enabled=?,freq_type=?,cron_expr=?,timezone=?,updated_at=? WHERE id=?',
  );
  const insertNodeStmt = db.prepare(
    'INSERT INTO job_steps (id,job_id,seq,type,name,config,on_failure,node_key,pos_x,pos_y,run_mode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const insertEdgeStmt = db.prepare(
    'INSERT INTO job_edges (id,job_id,source_key,target_key,created_at) VALUES (?,?,?,?,?)',
  );
  const deleteNodesStmt = db.prepare('DELETE FROM job_steps WHERE job_id = ?');
  const deleteEdgesStmt = db.prepare('DELETE FROM job_edges WHERE job_id = ?');
  const ownerStmt = db.prepare('SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC');
  const allStmt = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC');
  const enabledScheduledStmt = db.prepare(
    "SELECT * FROM jobs WHERE enabled = 1 AND cron_expr IS NOT NULL AND cron_expr != ''",
  );
  const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  const nodesStmt = db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq ASC');
  const edgesStmt = db.prepare('SELECT * FROM job_edges WHERE job_id = ? ORDER BY rowid ASC');
  const get = (id: string): JobRow | null => (getStmt.get(id) as JobRow | undefined) ?? null;

  const writeGraph = (jobId: string, nodes: JobNodeInput[], edges: JobEdgeInput[], now: number): void => {
    deleteEdgesStmt.run(jobId);
    deleteNodesStmt.run(jobId);
    nodes.forEach((n, i) => {
      insertNodeStmt.run(
        nanoid(12), jobId, i, n.type, n.name, n.config, n.onFailure,
        n.key, n.x, n.y, n.mode, now,
      );
    });
    for (const e of edges) {
      insertEdgeStmt.run(nanoid(12), jobId, e.source, e.target, now);
    }
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
        writeGraph(id, input.nodes, input.edges, now);
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
        writeGraph(id, input.nodes, input.edges, now);
      })();
      return get(id);
    },
    findById: get,
    listForOwner: (ownerId) => ownerStmt.all(ownerId) as JobRow[],
    listAll: () => allStmt.all() as JobRow[],
    listEnabledScheduled: () => enabledScheduledStmt.all() as JobRow[],
    remove: (id) => deleteJobStmt.run(id).changes > 0,
    listNodes: (jobId) => nodesStmt.all(jobId) as JobStepRow[],
    listEdges: (jobId) => edgesStmt.all(jobId) as JobEdgeRow[],
  };
}

export interface JobRunsRepo {
  create(input: {
    jobId: string;
    triggerType: 'manual' | 'schedule';
    triggeredBy: string | null;
    graphSnapshot?: string | null;
  }): JobRunRow;
  findById(id: string): JobRunRow | null;
  markRunning(id: string, startedAt: number): void;
  finish(id: string, patch: { status: JobRunStatus; finishedAt: number; durationMs: number | null; error: string | null }): void;
  listByJob(jobId: string, opts: { limit: number; offset: number }): JobRunRow[];
  countByJob(jobId: string): number;
  /** 跨 Job 的运行记录（按创建时间倒序）；ownerId 为 null 表示不限制归属（管理员）。 */
  listRecent(opts: { ownerId: string | null; limit: number; offset: number }): JobRunWithJobName[];
  countRecent(ownerId: string | null): number;
}

/** 运行记录 + 所属 Job 名称，用于「Job 日志」的全局运行列表。 */
export interface JobRunWithJobName extends JobRunRow {
  job_name: string;
}

export function jobRunsRepo(db: Database): JobRunsRepo {
  const getStmt = db.prepare('SELECT * FROM job_runs WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO job_runs (id,job_id,trigger_type,triggered_by,status,started_at,finished_at,duration_ms,error,graph_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const markRunningStmt = db.prepare("UPDATE job_runs SET status='running', started_at=? WHERE id=?");
  const finishStmt = db.prepare('UPDATE job_runs SET status=?, finished_at=?, duration_ms=?, error=? WHERE id=?');
  const listStmt = db.prepare('SELECT * FROM job_runs WHERE job_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM job_runs WHERE job_id=?');
  const recentStmt = db.prepare(
    `SELECT r.*, j.name AS job_name FROM job_runs r JOIN jobs j ON j.id = r.job_id
     WHERE (? IS NULL OR j.owner_id = ?) ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
  );
  const recentCountStmt = db.prepare(
    'SELECT COUNT(*) AS c FROM job_runs r JOIN jobs j ON j.id = r.job_id WHERE (? IS NULL OR j.owner_id = ?)',
  );
  const get = (id: string): JobRunRow | null => (getStmt.get(id) as JobRunRow | undefined) ?? null;
  return {
    create({ jobId, triggerType, triggeredBy, graphSnapshot }) {
      const id = nanoid(12);
      insertStmt.run(
        id, jobId, triggerType, triggeredBy, 'queued', null, null, null, null,
        graphSnapshot ?? null, Date.now(),
      );
      return get(id)!;
    },
    findById: get,
    markRunning: (id, startedAt) => markRunningStmt.run(startedAt, id),
    finish: (id, patch) => finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error, id),
    listByJob: (jobId, { limit, offset }) => listStmt.all(jobId, limit, offset) as JobRunRow[],
    countByJob: (jobId) => Number((countStmt.get(jobId) as { c: number }).c),
    listRecent: ({ ownerId, limit, offset }) =>
      recentStmt.all(ownerId, ownerId, limit, offset) as JobRunWithJobName[],
    countRecent: (ownerId) => Number((recentCountStmt.get(ownerId, ownerId) as { c: number }).c),
  };
}

export interface JobStepRunsRepo {
  createBatch(
    jobRunId: string,
    steps: Array<{
      stepId: string | null;
      nodeKey: string;
      seq: number;
      type: JobStepType;
      name: string;
      config: string;
      onFailure: JobOnFailure;
    }>,
  ): void;
  listByJobRun(jobRunId: string): JobStepRunRow[];
  markRunning(id: string, startedAt: number): void;
  finish(id: string, patch: { status: JobStepRunStatus; finishedAt: number; durationMs: number | null; error?: string | null; output?: string | null }): void;
  /** 把指定节点中仍为 pending 的运行记录标记为 skipped / canceled（幂等）。 */
  markSkipped(jobRunId: string, keys: string[], status: 'skipped' | 'canceled'): void;
  findByNodeKey(jobRunId: string, key: string): JobStepRunRow | null;
  findById(id: string): JobStepRunRow | null;
}

export function jobStepRunsRepo(db: Database): JobStepRunsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO job_step_runs (id,job_run_id,step_id,node_key,seq,type,name,config,on_failure,status,started_at,finished_at,duration_ms,error,output,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const listStmt = db.prepare('SELECT * FROM job_step_runs WHERE job_run_id=? ORDER BY seq ASC');
  const markRunningStmt = db.prepare("UPDATE job_step_runs SET status='running', started_at=? WHERE id=?");
  const finishStmt = db.prepare('UPDATE job_step_runs SET status=?, finished_at=?, duration_ms=?, error=?, output=? WHERE id=?');
  const markSkippedStmt = db.prepare(
    "UPDATE job_step_runs SET status=?, finished_at=? WHERE job_run_id=? AND node_key=? AND status='pending'",
  );
  const byKeyStmt = db.prepare('SELECT * FROM job_step_runs WHERE job_run_id=? AND node_key=?');
  const getStmt = db.prepare('SELECT * FROM job_step_runs WHERE id=?');
  const get = (id: string): JobStepRunRow | null => (getStmt.get(id) as JobStepRunRow | undefined) ?? null;
  const byKey = (jobRunId: string, key: string): JobStepRunRow | null =>
    (byKeyStmt.get(jobRunId, key) as JobStepRunRow | undefined) ?? null;
  return {
    createBatch(jobRunId, steps) {
      const now = Date.now();
      db.transaction(() => {
        for (const s of steps) {
          insertStmt.run(
            nanoid(12), jobRunId, s.stepId, s.nodeKey, s.seq, s.type, s.name, s.config, s.onFailure,
            'pending', null, null, null, null, null, now,
          );
        }
      })();
    },
    listByJobRun: (jobRunId) => listStmt.all(jobRunId) as JobStepRunRow[],
    markRunning: (id, startedAt) => markRunningStmt.run(startedAt, id),
    finish: (id, patch) =>
      finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error ?? null, patch.output ?? null, id),
    markSkipped(jobRunId, keys, status) {
      if (keys.length === 0) return;
      const now = Date.now();
      db.transaction(() => {
        for (const key of keys) markSkippedStmt.run(status, now, jobRunId, key);
      })();
    },
    findByNodeKey: byKey,
    findById: get,
  };
}
