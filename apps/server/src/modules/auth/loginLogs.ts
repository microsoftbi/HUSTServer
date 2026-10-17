import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface LoginLogRow {
  id: string;
  user_id: string | null;
  username: string;
  success: number;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface LoginLogInput {
  userId: string | null;
  username: string;
  success: boolean;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginLogsRepo {
  record(input: LoginLogInput): void;
  listByUser(userId: string, limit: number): LoginLogRow[];
}

export function loginLogsRepo(db: Database): LoginLogsRepo {
  const insert = db.prepare(
    'INSERT INTO login_logs (id, user_id, username, success, reason, ip, user_agent, created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const listStmt = db.prepare(
    'SELECT * FROM login_logs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
  );

  return {
    record({ userId, username, success, reason = null, ip = null, userAgent = null }) {
      insert.run(nanoid(12), userId, username, success ? 1 : 0, reason, ip, userAgent, Date.now());
    },
    listByUser: (userId, limit) => listStmt.all(userId, limit) as LoginLogRow[],
  };
}
