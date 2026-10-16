import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { dataModelsRepo } from '../src/modules/models/repo.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';

let db: Database.Database;
let store: ModelStore;
/** data_models.owner_id 有 REFERENCES users(id) 外键且 migrate 打开了 foreign_keys，
 *  故必须插入真实用户行，不能使用任意字符串。 */
let ownerId: string;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-svc-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-svc-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n3,30\n', 'utf-8');
  fs.writeFileSync(path.join(resourceDir, 'small.csv'), 'id,amount\n9,90\n', 'utf-8');

  db = new Database(':memory:');
  migrate(db);
  ownerId = 'u1';
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(ownerId, 'u1', 'x', 'workflow_author', 'active', Date.now(), Date.now());
  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  store = createModelStore({ db, config: cfg });
});

afterEach(() => {
  store.close();
  db.close();
});

describe('createModelStore', () => {
  it('load 从资源库 CSV 建模型并 upsert 元数据', async () => {
    const res = await store.load(
      { source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' },
      ownerId,
    );
    expect(res.rowCount).toBe(3);
    expect(res.columns.map((c) => c.name)).toEqual(['id', 'amount']);

    const row = dataModelsRepo(db).findByName('sales_model')!;
    expect(row.source_kind).toBe('csv');
    expect(row.row_count).toBe(3);
    expect(row.owner_id).toBe(ownerId);
    expect(JSON.parse(row.source_ref)).toEqual({ resourcePath: 'sales.csv', format: 'csv' });
    expect((JSON.parse(row.columns) as Array<{ name: string }>).map((c) => c.name)).toEqual(['id', 'amount']);
  });

  it('重复 load 同名模型为覆盖：行数按新数据刷新', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    const again = await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'small.csv' }, null);
    expect(again.rowCount).toBe(1);
    expect(dataModelsRepo(db).findByName('sales_model')!.row_count).toBe(1);
    const q = await store.query('sales_model');
    expect(q.rows).toHaveLength(1);
  });

  it('加载失败时不破坏已有模型', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    await expect(
      store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'missing.csv' }, null),
    ).rejects.toThrow();
    const q = await store.query('sales_model');
    expect(q.rows).toHaveLength(3);
  });

  it('query 返回 { columns, rows, truncated }', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    const q = await store.query('sales_model');
    expect(q.columns.map((c) => c.name)).toEqual(['id', 'amount']);
    expect(q.columns.map((c) => c.type)).toEqual(['number', 'number']);
    expect(q.rows).toEqual([[1, 10], [2, 20], [3, 30]]);
    expect(q.truncated).toBe(false);
  });

  it('rename 同步 DuckDB 表与元数据；remove 双双删除', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    await store.rename('sales_model', 'sales_model_v2');
    expect(dataModelsRepo(db).findByName('sales_model')).toBeNull();
    expect(dataModelsRepo(db).findByName('sales_model_v2')).not.toBeNull();
    expect((await store.query('sales_model_v2')).rows).toHaveLength(3);

    await store.remove('sales_model_v2');
    expect(dataModelsRepo(db).findByName('sales_model_v2')).toBeNull();
    await expect(store.query('sales_model_v2')).rejects.toThrow();
  });
});
