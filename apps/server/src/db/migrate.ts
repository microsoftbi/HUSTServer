import type { Database } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'workflow_author',
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

CREATE TABLE IF NOT EXISTS dashboards (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT REFERENCES users(id),
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
`;

const JOB_TABLES = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 0,
  freq_type   TEXT,
  cron_expr   TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_steps (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  on_failure TEXT NOT NULL DEFAULT 'abort',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  triggered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_step_runs (
  id           TEXT PRIMARY KEY,
  job_run_id   TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step_id      TEXT,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  config       TEXT NOT NULL DEFAULT '{}',
  on_failure   TEXT NOT NULL DEFAULT 'abort',
  status       TEXT NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  output       TEXT,
  created_at   INTEGER NOT NULL
);
`;

const JOB_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_jobs_owner        ON jobs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_steps_job     ON job_steps(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_runs_job      ON job_runs(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_step_runs_run ON job_step_runs(job_run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_job_run      ON runs(job_run_id);
`;

const LOGIN_LOG_TABLES = `
CREATE TABLE IF NOT EXISTS login_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT NOT NULL,
  success    INTEGER NOT NULL,
  reason     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id, created_at DESC);
`;

const AUDIT_TABLES = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  username      TEXT NOT NULL,
  action        TEXT NOT NULL,
  resource      TEXT NOT NULL,
  resource_name TEXT,
  description   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
`;

const MODEL_TABLES = `
CREATE TABLE IF NOT EXISTS data_models (
  name        TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  loaded_at   INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  columns     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_models_loaded ON data_models(loaded_at DESC);

-- 列类型配置：按模型名映射，columns 为 [{ name, type }] 的 JSON（仅保存被改写的列）
CREATE TABLE IF NOT EXISTS model_column_configs (
  model_name TEXT PRIMARY KEY,
  columns    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function backfillUserRoles(db: Database): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number };
  if (c > 0) return;
  const rows = db.prepare('SELECT id, role FROM users').all() as { id: string; role: string }[];
  const insert = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run(row.id, row.role === 'admin' ? 'admin' : 'workflow_author');
    }
  });
  tx();
}

export function migrate(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  backfillUserRoles(db);
  db.exec(JOB_TABLES);
  db.exec(LOGIN_LOG_TABLES);
  db.exec(AUDIT_TABLES);
  db.exec(MODEL_TABLES);
  const runCols = (db.pragma('table_info(runs)') as Array<{ name: string }>).map((c) => c.name);
  if (!runCols.includes('job_run_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL');
  }
  // 仪表板已取消共享功能（对所有具备 dashboard.view 的用户可见），清掉历史库中的 shared 列
  const dashCols = (db.pragma('table_info(dashboards)') as Array<{ name: string }>).map((c) => c.name);
  if (dashCols.includes('shared')) {
    db.exec('ALTER TABLE dashboards DROP COLUMN shared');
  }
  db.exec(JOB_INDEXES);
}
