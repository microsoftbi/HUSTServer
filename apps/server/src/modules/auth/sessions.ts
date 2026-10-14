import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface SessionsRepo {
  create(userId: string, ttlMs: number): SessionRow;
  findValid(token: string, now?: number): SessionRow | null;
  remove(token: string): void;
  removeByUser(userId: string): void;
  purgeExpired(now?: number): number;
}

export function sessionsRepo(db: Database): SessionsRepo {
  const insert = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)');
  const get = db.prepare('SELECT * FROM sessions WHERE token = ?');
  const del = db.prepare('DELETE FROM sessions WHERE token = ?');
  const delByUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    create(userId, ttlMs) {
      const now = Date.now();
      const token = randomBytes(32).toString('hex');
      insert.run(token, userId, now, now + ttlMs);
      return { token, user_id: userId, created_at: now, expires_at: now + ttlMs };
    },
    findValid(token, now = Date.now()) {
      const row = get.get(token) as SessionRow | undefined;
      if (!row) return null;
      if (row.expires_at <= now) {
        del.run(token);
        return null;
      }
      return row;
    },
    remove: (token) => {
      del.run(token);
    },
    removeByUser: (userId) => {
      delByUser.run(userId);
    },
    purgeExpired: (now = Date.now()) => purge.run(now).changes,
  };
}
