import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { FreqType } from './cron.js';

export interface ScheduleRow {
  id: string;
  workflow_id: string;
  enabled: number;
  freq_type: FreqType;
  cron_expr: string;
  timezone: string;
  created_at: number;
  updated_at: number;
}

export interface SchedulesRepo {
  create(input: {
    workflowId: string;
    freqType: FreqType;
    cronExpr: string;
    timezone?: string;
    enabled?: boolean;
  }): ScheduleRow;
  findById(id: string): ScheduleRow | null;
  listByWorkflow(workflowId: string): ScheduleRow[];
  listEnabled(): ScheduleRow[];
  update(
    id: string,
    patch: { freqType?: FreqType; cronExpr?: string; timezone?: string; enabled?: boolean },
  ): ScheduleRow | null;
  remove(id: string): boolean;
}

export function schedulesRepo(db: Database): SchedulesRepo {
  const getStmt = db.prepare('SELECT * FROM schedules WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO schedules (id,workflow_id,enabled,freq_type,cron_expr,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const byWorkflowStmt = db.prepare(
    'SELECT * FROM schedules WHERE workflow_id = ? ORDER BY created_at ASC',
  );
  const enabledStmt = db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at ASC');
  const updateStmt = db.prepare(
    'UPDATE schedules SET enabled=?, freq_type=?, cron_expr=?, timezone=?, updated_at=? WHERE id=?',
  );
  const deleteStmt = db.prepare('DELETE FROM schedules WHERE id = ?');
  const get = (id: string): ScheduleRow | null => (getStmt.get(id) as ScheduleRow | undefined) ?? null;

  return {
    create({ workflowId, freqType, cronExpr, timezone = 'Asia/Shanghai', enabled = true }) {
      const id = nanoid(12);
      const now = Date.now();
      insertStmt.run(id, workflowId, enabled ? 1 : 0, freqType, cronExpr, timezone, now, now);
      return get(id)!;
    },
    findById: get,
    listByWorkflow: (workflowId) => byWorkflowStmt.all(workflowId) as ScheduleRow[],
    listEnabled: () => enabledStmt.all() as ScheduleRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0;
      const freqType = patch.freqType ?? cur.freq_type;
      const cronExpr = patch.cronExpr ?? cur.cron_expr;
      const timezone = patch.timezone ?? cur.timezone;
      updateStmt.run(enabled, freqType, cronExpr, timezone, Date.now(), id);
      return get(id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
  };
}
