import type { Database } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_files (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id       TEXT,
  original_ref  TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'sqlserver',
  config_encrypted TEXT NOT NULL,
  shared           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS path_mappings (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  direction    TEXT NOT NULL,
  original_ref TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_ref   TEXT
);

CREATE TABLE IF NOT EXISTS workflow_connections (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id          TEXT NOT NULL,
  config_encrypted TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  freq_type   TEXT NOT NULL,
  cron_expr   TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  schedule_id   TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  trigger_type  TEXT NOT NULL,
  triggered_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL,
  engine_run_id TEXT,
  started_at    INTEGER,
  finished_at   INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_node_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  name        TEXT,
  kind        TEXT,
  status      TEXT NOT NULL,
  row_count   INTEGER,
  duration_ms INTEGER,
  error       TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL,
  node_id  TEXT,
  message  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_conn_node ON workflow_connections(workflow_id, node_id);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_logs_run  ON run_logs(run_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_nodes_run ON run_node_results(run_id, node_id);
`;

export function migrate(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
}
