import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface ConnectionRow {
  id: string;
  owner_id: string | null;
  name: string;
  type: string;
  config_encrypted: string;
  shared: number;
  created_at: number;
  updated_at: number;
}

export interface ConnectionsRepo {
  create(input: { ownerId: string | null; name: string; type: string; configEncrypted: string; shared: boolean }): ConnectionRow;
  findById(id: string): ConnectionRow | null;
  listForOwner(ownerId: string): ConnectionRow[];
  listAll(): ConnectionRow[];
  update(id: string, patch: { name?: string; configEncrypted?: string; shared?: boolean }): ConnectionRow | null;
  remove(id: string): boolean;
}

export function connectionsRepo(db: Database): ConnectionsRepo {
  const insert = db.prepare('INSERT INTO connections (id, owner_id, name, type, config_encrypted, shared, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM connections WHERE id = ?');
  const visible = db.prepare("SELECT * FROM connections WHERE shared = 1 OR owner_id = ? ORDER BY created_at DESC");
  const all = db.prepare('SELECT * FROM connections ORDER BY created_at DESC');
  const del = db.prepare('DELETE FROM connections WHERE id = ?');
  const get = (id: string) => (byId.get(id) as ConnectionRow | undefined) ?? null;

  return {
    create({ ownerId, name, type, configEncrypted, shared }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, type, configEncrypted, shared ? 1 : 0, now, now);
      return get(id)!;
    },
    findById: get,
    listForOwner: (ownerId) => visible.all(ownerId) as ConnectionRow[],
    listAll: () => all.all() as ConnectionRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      db.prepare('UPDATE connections SET name = ?, config_encrypted = ?, shared = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? cur.name, patch.configEncrypted ?? cur.config_encrypted, patch.shared ? 1 : patch.shared === false ? 0 : cur.shared, Date.now(), id);
      return get(id);
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
