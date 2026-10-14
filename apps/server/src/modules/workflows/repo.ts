import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface WorkflowRow {
  id: string;
  owner_id: string;
  name: string;
  payload: string;
  created_at: number;
  updated_at: number;
}

export interface WorkflowsRepo {
  create(input: { ownerId: string; name: string; payload: string }): WorkflowRow;
  findById(id: string): WorkflowRow | null;
  listForOwner(ownerId: string): WorkflowRow[];
  listAll(): WorkflowRow[];
  remove(id: string): boolean;
  update(id: string, patch: { name?: string; payload?: string }): WorkflowRow | null;
}

export function workflowsRepo(db: Database): WorkflowsRepo {
  const insert = db.prepare('INSERT INTO workflows (id, owner_id, name, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM workflows WHERE id = ?');
  const byOwner = db.prepare('SELECT * FROM workflows WHERE owner_id = ? ORDER BY updated_at DESC');
  const all = db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC');
  const del = db.prepare('DELETE FROM workflows WHERE id = ?');
  const update = db.prepare('UPDATE workflows SET name = COALESCE(?, name), payload = COALESCE(?, payload), updated_at = ? WHERE id = ?');
  const get = (id: string) => (byId.get(id) as WorkflowRow | undefined) ?? null;

  return {
    create({ ownerId, name, payload }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, payload, now, now);
      return get(id)!;
    },
    findById: get,
    listForOwner: (ownerId) => byOwner.all(ownerId) as WorkflowRow[],
    listAll: () => all.all() as WorkflowRow[],
    remove: (id) => del.run(id).changes > 0,
    update(id: string, patch: { name?: string; payload?: string }) {
      update.run(patch.name ?? null, patch.payload ?? null, Date.now(), id);
      return get(id);
    },
  };
}

export interface WorkflowFileRow {
  id: string;
  workflow_id: string;
  node_id: string | null;
  original_ref: string;
  stored_name: string;
  size: number;
  created_at: number;
}

export interface WorkflowFilesRepo {
  add(input: { workflowId: string; nodeId: string | null; originalRef: string; storedName: string; size: number }): WorkflowFileRow;
  listByWorkflow(workflowId: string): WorkflowFileRow[];
  findByNode(workflowId: string, nodeId: string): WorkflowFileRow | null;
  remove(id: string): void;
}

export function workflowFilesRepo(db: Database): WorkflowFilesRepo {
  const insert = db.prepare('INSERT INTO workflow_files (id, workflow_id, node_id, original_ref, stored_name, size, created_at) VALUES (?,?,?,?,?,?,?)');
  const byWf = db.prepare('SELECT * FROM workflow_files WHERE workflow_id = ? ORDER BY created_at ASC');
  const byNode = db.prepare('SELECT * FROM workflow_files WHERE workflow_id = ? AND node_id = ? LIMIT 1');
  const del = db.prepare('DELETE FROM workflow_files WHERE id = ?');
  return {
    add({ workflowId, nodeId, originalRef, storedName, size }) {
      const row: WorkflowFileRow = {
        id: nanoid(12), workflow_id: workflowId, node_id: nodeId,
        original_ref: originalRef, stored_name: storedName, size, created_at: Date.now(),
      };
      insert.run(row.id, row.workflow_id, row.node_id, row.original_ref, row.stored_name, row.size, row.created_at);
      return row;
    },
    listByWorkflow: (workflowId) => byWf.all(workflowId) as WorkflowFileRow[],
    findByNode: (workflowId, nodeId) => (byNode.get(workflowId, nodeId) as WorkflowFileRow | undefined) ?? null,
    remove: (id) => {
      del.run(id);
    },
  };
}

export type MappingDirection = 'input' | 'output';
export type MappingTargetType = 'uploaded_file' | 'server_path' | 'connection' | 'output_dir';

export interface PathMappingRow {
  id: string;
  workflow_id: string;
  node_id: string;
  direction: MappingDirection;
  original_ref: string;
  target_type: MappingTargetType;
  target_ref: string | null;
}
export type PathMappingInput = Omit<PathMappingRow, 'id'>;

export interface PathMappingsRepo {
  replaceForWorkflow(workflowId: string, mappings: PathMappingInput[]): void;
  listByWorkflow(workflowId: string): PathMappingRow[];
}

export function pathMappingsRepo(db: Database): PathMappingsRepo {
  const del = db.prepare('DELETE FROM path_mappings WHERE workflow_id = ?');
  const insert = db.prepare('INSERT INTO path_mappings (id, workflow_id, node_id, direction, original_ref, target_type, target_ref) VALUES (?,?,?,?,?,?,?)');
  const byWf = db.prepare('SELECT * FROM path_mappings WHERE workflow_id = ? ORDER BY direction ASC, node_id ASC');
  return {
    replaceForWorkflow(workflowId, mappings) {
      const tx = db.transaction(() => {
        del.run(workflowId);
        for (const m of mappings) {
          insert.run(nanoid(12), workflowId, m.node_id, m.direction, m.original_ref, m.target_type, m.target_ref);
        }
      });
      tx();
    },
    listByWorkflow: (workflowId) => byWf.all(workflowId) as PathMappingRow[],
  };
}

export interface WorkflowConnectionRow {
  id: string;
  workflow_id: string;
  node_id: string;
  config_encrypted: string;
  created_at: number;
  updated_at: number;
}

export interface WorkflowConnectionsRepo {
  upsert(input: { workflowId: string; nodeId: string; configEncrypted: string }): WorkflowConnectionRow;
  listByWorkflow(workflowId: string): WorkflowConnectionRow[];
  findByNode(workflowId: string, nodeId: string): WorkflowConnectionRow | null;
  remove(workflowId: string, nodeId: string): void;
  /** 对账删除：清除该工作流下 node_id 不在集合中的行；集合为空时清除全部。 */
  delNotIn(workflowId: string, nodeIds: string[]): void;
}

export function workflowConnectionsRepo(db: Database): WorkflowConnectionsRepo {
  const insert = db.prepare('INSERT INTO workflow_connections (id, workflow_id, node_id, config_encrypted, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  const update = db.prepare('UPDATE workflow_connections SET config_encrypted = ?, updated_at = ? WHERE id = ?');
  const byWf = db.prepare('SELECT * FROM workflow_connections WHERE workflow_id = ? ORDER BY node_id ASC');
  const byNode = db.prepare('SELECT * FROM workflow_connections WHERE workflow_id = ? AND node_id = ? LIMIT 1');
  const del = db.prepare('DELETE FROM workflow_connections WHERE workflow_id = ? AND node_id = ?');
  const delAllByWf = db.prepare('DELETE FROM workflow_connections WHERE workflow_id = ?');
  const get = (workflowId: string, nodeId: string) => (byNode.get(workflowId, nodeId) as WorkflowConnectionRow | undefined) ?? null;
  return {
    upsert({ workflowId, nodeId, configEncrypted }) {
      const existing = get(workflowId, nodeId);
      if (existing) {
        update.run(configEncrypted, Date.now(), existing.id);
        return get(workflowId, nodeId)!;
      }
      const now = Date.now();
      insert.run(nanoid(12), workflowId, nodeId, configEncrypted, now, now);
      return get(workflowId, nodeId)!;
    },
    listByWorkflow: (workflowId) => byWf.all(workflowId) as WorkflowConnectionRow[],
    findByNode: get,
    remove: (workflowId, nodeId) => {
      del.run(workflowId, nodeId);
    },
    // SQL 的 NOT IN 不支持空集合：为空时退化为删除该工作流全部连接行。
    delNotIn(workflowId, nodeIds) {
      if (nodeIds.length === 0) {
        delAllByWf.run(workflowId);
        return;
      }
      const sql = `DELETE FROM workflow_connections WHERE workflow_id = ? AND node_id NOT IN (${nodeIds.map(() => '?').join(', ')})`;
      db.prepare(sql).run(workflowId, ...nodeIds);
    },
  };
}
