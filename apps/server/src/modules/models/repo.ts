import type { Database } from 'better-sqlite3';

export type ModelSourceKind = 'csv' | 'excel' | 'sqlserver' | 'audit';

export interface DataModelRow {
  name: string;
  source_kind: ModelSourceKind;
  source_ref: string;
  owner_id: string | null;
  loaded_at: number;
  row_count: number;
  columns: string;
  created_at: number;
}

export interface DataModelsRepo {
  upsert(row: {
    name: string;
    sourceKind: ModelSourceKind;
    sourceRef: string;
    ownerId: string | null;
    loadedAt: number;
    rowCount: number;
    columns: string;
  }): DataModelRow;
  list(): DataModelRow[];
  findByName(name: string): DataModelRow | null;
  rename(oldName: string, newName: string): boolean;
  remove(name: string): boolean;
}

export interface ModelColumnConfigRow {
  model_name: string;
  /** [{ name, type }] 的 JSON，仅包含被用户改写的列 */
  columns: string;
  updated_at: number;
}

export interface ModelColumnConfigsRepo {
  get(modelName: string): ModelColumnConfigRow | null;
  save(modelName: string, columns: string): void;
  remove(modelName: string): boolean;
  rename(oldName: string, newName: string): boolean;
}

/** 列类型配置仓库：独立表，通过模型名映射到 data_models 中的模型。 */
export function modelColumnConfigsRepo(db: Database): ModelColumnConfigsRepo {
  const byName = db.prepare('SELECT * FROM model_column_configs WHERE model_name = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO model_column_configs (model_name, columns, updated_at)
    VALUES (?,?,?)
    ON CONFLICT(model_name) DO UPDATE SET
      columns    = excluded.columns,
      updated_at = excluded.updated_at
  `);
  const del = db.prepare('DELETE FROM model_column_configs WHERE model_name = ?');
  const renameStmt = db.prepare('UPDATE model_column_configs SET model_name = ? WHERE model_name = ?');

  return {
    get: (name) => (byName.get(name) as ModelColumnConfigRow | undefined) ?? null,
    save(modelName, columns) {
      upsertStmt.run(modelName, columns, Date.now());
    },
    remove: (name) => del.run(name).changes > 0,
    rename: (oldName, newName) => renameStmt.run(newName, oldName).changes > 0,
  };
}

export function dataModelsRepo(db: Database): DataModelsRepo {
  const byName = db.prepare('SELECT * FROM data_models WHERE name = ?');
  const get = (name: string) => (byName.get(name) as DataModelRow | undefined) ?? null;
  const all = db.prepare('SELECT * FROM data_models ORDER BY loaded_at DESC');
  const upsertStmt = db.prepare(`
    INSERT INTO data_models (name, source_kind, source_ref, owner_id, loaded_at, row_count, columns, created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      source_kind = excluded.source_kind,
      source_ref  = excluded.source_ref,
      owner_id    = excluded.owner_id,
      loaded_at   = excluded.loaded_at,
      row_count   = excluded.row_count,
      columns     = excluded.columns
  `);
  const renameStmt = db.prepare('UPDATE data_models SET name = ? WHERE name = ?');
  const del = db.prepare('DELETE FROM data_models WHERE name = ?');

  return {
    upsert(row) {
      upsertStmt.run(
        row.name, row.sourceKind, row.sourceRef, row.ownerId,
        row.loadedAt, row.rowCount, row.columns, Date.now(),
      );
      return get(row.name)!;
    },
    list: () => all.all() as DataModelRow[],
    findByName: get,
    rename: (oldName, newName) => renameStmt.run(newName, oldName).changes > 0,
    remove: (name) => del.run(name).changes > 0,
  };
}
