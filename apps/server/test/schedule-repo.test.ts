import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { schedulesRepo, type SchedulesRepo } from '../src/modules/schedules/repo.js';

let db: Database.Database;
let repo: SchedulesRepo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO users (id,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('u1', 'alice', 'x', 'user', 'active', 0, 0);
  db.prepare(
    'INSERT INTO workflows (id,owner_id,name,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('w1', 'u1', 'wf', '{"nodes":[],"edges":[]}', 0, 0);
  repo = schedulesRepo(db);
});

describe('schedulesRepo', () => {
  it('创建返回完整行，默认时区与启用状态', () => {
    const row = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    expect(row).toMatchObject({
      workflow_id: 'w1',
      enabled: 1,
      freq_type: 'daily',
      cron_expr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    });
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('按工作流列出，按启用状态筛选', () => {
    const a = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    repo.create({ workflowId: 'w1', freqType: 'cron', cronExpr: '*/5 * * * *', enabled: false });
    expect(repo.listByWorkflow('w1')).toHaveLength(2);
    expect(repo.listEnabled()).toHaveLength(1);
    expect(repo.listEnabled()[0].id).toBe(a.id);
  });

  it('更新可启停与改表达式，未提供的字段保持原值', () => {
    const row = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    const off = repo.update(row.id, { enabled: false })!;
    expect(off.enabled).toBe(0);
    expect(off.cron_expr).toBe('0 9 * * *');
    const changed = repo.update(row.id, { freqType: 'cron', cronExpr: '0 3 * * *', enabled: true })!;
    expect(changed).toMatchObject({ enabled: 1, freq_type: 'cron', cron_expr: '0 3 * * *' });
    expect(changed.updated_at).toBeGreaterThanOrEqual(row.updated_at);
  });

  it('更新不存在的调度返回 null；删除返回布尔', () => {
    expect(repo.update('nope', { enabled: false })).toBeNull();
    const row = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    expect(repo.remove(row.id)).toBe(true);
    expect(repo.remove(row.id)).toBe(false);
    expect(repo.findById(row.id)).toBeNull();
  });

  it('删除工作流级联删除其调度', () => {
    repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    db.prepare('DELETE FROM workflows WHERE id = ?').run('w1');
    expect(repo.listByWorkflow('w1')).toHaveLength(0);
  });
});
