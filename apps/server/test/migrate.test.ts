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
});
