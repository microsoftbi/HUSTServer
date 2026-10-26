import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
}

describe('migrate', () => {
  it('创建全部业务表', () => {
    const db = new Database(':memory:');
    migrate(db);
    const names = tableNames(db);
    for (const t of ['users', 'sessions', 'workflows', 'workflow_files', 'connections',
      'path_mappings', 'schedules', 'runs', 'run_node_results', 'run_logs', 'settings', 'dashboards',
      'user_roles', 'data_models']) {
      expect(names).toContain(t);
    }
  });

  it('重复执行幂等', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('run_node_results 具备 (run_id,node_id) 唯一索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_node_results'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_run_nodes_run');
  });

  it('dashboards 具备 (owner_id, created_at) 索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dashboards'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_dashboards_owner');
  });

  it('user_roles 具备 role 索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_roles'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_user_roles_role');
  });

  it('data_models 具备 loaded_at 索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='data_models'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_data_models_loaded');
  });

  it('画布化：job_steps/job_runs/job_step_runs 具备新列，且有 job_edges 表与索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const cols = (table: string) =>
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
    expect(cols('job_steps')).toEqual(expect.arrayContaining(['node_key', 'pos_x', 'pos_y', 'run_mode']));
    expect(cols('job_runs')).toContain('graph_snapshot');
    expect(cols('job_step_runs')).toContain('node_key');
    expect(tableNames(db)).toContain('job_edges');
    const stepIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_steps'").all() as Array<{ name: string }>;
    expect(stepIdx.map((r) => r.name)).toContain('idx_job_steps_key');
    const edgeIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_edges'").all() as Array<{ name: string }>;
    expect(edgeIdx.map((r) => r.name)).toContain('idx_job_edges_pair');
  });

  it('画布化：旧库升级时回填 node_key/坐标，并按 seq 生成线性边', () => {
    const db = legacyDb();
    migrate(db);
    const steps = db
      .prepare('SELECT id, seq, node_key, pos_x, pos_y, run_mode FROM job_steps ORDER BY seq')
      .all() as Array<{ id: string; seq: number; node_key: string; pos_x: number; pos_y: number; run_mode: string }>;
    expect(steps.map((s) => s.node_key)).toEqual(['s1', 's2', 's3']);
    expect(steps.map((s) => s.pos_x)).toEqual([0, 260, 520]);
    expect(steps.every((s) => s.pos_y === 0)).toBe(true);
    expect(steps.every((s) => s.run_mode === 'run')).toBe(true);

    const edges = db
      .prepare('SELECT source_key, target_key FROM job_edges ORDER BY rowid')
      .all() as Array<{ source_key: string; target_key: string }>;
    expect(edges).toEqual([
      { source_key: 's1', target_key: 's2' },
      { source_key: 's2', target_key: 's3' },
    ]);
  });

  it('画布化：旧库升级可重复执行且不重复生成边', () => {
    const db = legacyDb();
    migrate(db);
    const before = db.prepare('SELECT COUNT(*) AS c FROM job_edges').get() as { c: number };
    migrate(db);
    const after = db.prepare('SELECT COUNT(*) AS c FROM job_edges').get() as { c: number };
    expect(after.c).toBe(before.c);
    const step = db.prepare("SELECT node_key, pos_x FROM job_steps WHERE id='s1'").get() as { node_key: string; pos_x: number };
    expect(step).toEqual({ node_key: 's1', pos_x: 0 });
  });

  it('画布化：已有边的 Job 不被线性边覆盖', () => {
    const db = legacyDb();
    migrate(db);
    db.prepare('DELETE FROM job_edges').run();
    db.prepare(
      "INSERT INTO job_edges (id, job_id, source_key, target_key, created_at) VALUES ('e1','j1','s1','s3',1)",
    ).run();
    migrate(db);
    const edges = db.prepare('SELECT source_key, target_key FROM job_edges').all() as Array<{ source_key: string; target_key: string }>;
    expect(edges).toEqual([{ source_key: 's1', target_key: 's3' }]);
  });
});

/** 构造一个「画布化之前」的旧库（无 node_key/坐标/run_mode/graph_snapshot，且无 job_edges）。 */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      enabled INTEGER NOT NULL DEFAULT 0, freq_type TEXT, cron_expr TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE job_steps (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
      name TEXT NOT NULL, config TEXT NOT NULL, on_failure TEXT NOT NULL DEFAULT 'abort',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, trigger_type TEXT NOT NULL, triggered_by TEXT,
      status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, duration_ms INTEGER,
      error TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE job_step_runs (
      id TEXT PRIMARY KEY, job_run_id TEXT NOT NULL, step_id TEXT, seq INTEGER NOT NULL,
      type TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
      on_failure TEXT NOT NULL DEFAULT 'abort', status TEXT NOT NULL, started_at INTEGER,
      finished_at INTEGER, duration_ms INTEGER, error TEXT, output TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO jobs (id, owner_id, name, created_at, updated_at) VALUES ('j1','u1','旧 Job',1,1);
    INSERT INTO job_steps (id, job_id, seq, type, name, config, created_at) VALUES
      ('s1','j1',0,'sql','第一步','{}',1),
      ('s2','j1',1,'sql','第二步','{}',1),
      ('s3','j1',2,'sql','第三步','{}',1);
  `);
  return db;
}
