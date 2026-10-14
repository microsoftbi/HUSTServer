import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo, workflowFilesRepo, pathMappingsRepo } from '../src/modules/workflows/repo.js';
import { sanitizeName, storeUpload } from '../src/modules/workflows/storage.js';

let db: Database.Database;
let ownerId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', role: 'user' }).id;
});

describe('workflowsRepo', () => {
  it('创建并按 owner 过滤，管理员可见全部', () => {
    const repo = workflowsRepo(db);
    const w1 = repo.create({ ownerId, name: 'A', payload: '{"nodes":[],"edges":[]}' });
    expect(repo.findById(w1.id)?.name).toBe('A');
    expect(repo.listForOwner(ownerId)).toHaveLength(1);
    expect(repo.listAll()).toHaveLength(1);
    repo.update(w1.id, { payload: '{"nodes":[1],"edges":[]}' });
    expect(repo.findById(w1.id)?.payload).toContain('[1]');
    expect(repo.remove(w1.id)).toBe(true);
    expect(repo.findById(w1.id)).toBeNull();
  });

  it('删除工作流级联清理文件与映射', () => {
    const w = workflowsRepo(db).create({ ownerId, name: 'A', payload: '{}' });
    workflowFilesRepo(db).add({ workflowId: w.id, nodeId: 'n1', originalRef: '/a.csv', storedName: 'f.csv', size: 3 });
    pathMappingsRepo(db).replaceForWorkflow(w.id, [
      { workflow_id: w.id, node_id: 'n1', direction: 'input', original_ref: '/a.csv', target_type: 'uploaded_file', target_ref: 'f.csv' },
    ]);
    workflowsRepo(db).remove(w.id);
    expect(workflowFilesRepo(db).listByWorkflow(w.id)).toHaveLength(0);
    expect(pathMappingsRepo(db).listByWorkflow(w.id)).toHaveLength(0);
  });
});

describe('pathMappingsRepo', () => {
  it('replaceForWorkflow 为幂等覆盖', () => {
    const w = workflowsRepo(db).create({ ownerId, name: 'A', payload: '{}' });
    const repo = pathMappingsRepo(db);
    repo.replaceForWorkflow(w.id, [
      { workflow_id: w.id, node_id: 'n1', direction: 'input', original_ref: '/a.csv', target_type: 'uploaded_file', target_ref: 'x.csv' },
      { workflow_id: w.id, node_id: 'n2', direction: 'output', original_ref: '/o.csv', target_type: 'output_dir', target_ref: null },
    ]);
    repo.replaceForWorkflow(w.id, [
      { workflow_id: w.id, node_id: 'n1', direction: 'input', original_ref: '/a.csv', target_type: 'server_path', target_ref: '/data/a.csv' },
    ]);
    const rows = repo.listByWorkflow(w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].target_type).toBe('server_path');
  });
});

describe('storage', () => {
  it('文件名去穿越并加时间戳，落盘成功', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeName('订单 数据.csv')).toMatch(/\.csv$/);
    const dir = mkdtempSync(join(tmpdir(), 'hs-up-'));
    const { storedName, size } = storeUpload(dir, 'data.csv', Buffer.from('a,b\n1,2\n'));
    expect(size).toBe(8);
    expect(readFileSync(join(dir, storedName), 'utf8')).toBe('a,b\n1,2\n');
  });
});
