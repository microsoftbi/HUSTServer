import Database from 'better-sqlite3';

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export type { Database };
