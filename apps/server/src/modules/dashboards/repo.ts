import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface DashboardRow {
  id: string;
  owner_id: string | null;
  name: string;
  payload: string;
  shared: number;
  created_at: number;
  updated_at: number;
}

export interface DashboardsRepo {
  create(input: { ownerId: string; name: string; payload: string; shared: boolean }): DashboardRow;
  findById(id: string): DashboardRow | null;
  listForOwner(ownerId: string): DashboardRow[];
  listAll(): DashboardRow[];
  update(id: string, patch: { name?: string; payload?: string; shared?: boolean }): DashboardRow | null;
  remove(id: string): boolean;
}

export function dashboardsRepo(db: Database): DashboardsRepo {
  const insert = db.prepare('INSERT INTO dashboards (id, owner_id, name, payload, shared, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM dashboards WHERE id = ?');
  const visible = db.prepare('SELECT * FROM dashboards WHERE shared = 1 OR owner_id = ? ORDER BY created_at DESC');
  const all = db.prepare('SELECT * FROM dashboards ORDER BY created_at DESC');
  const del = db.prepare('DELETE FROM dashboards WHERE id = ?');
  const get = (id: string) => (byId.get(id) as DashboardRow | undefined) ?? null;

  return {
    create({ ownerId, name, payload, shared }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, payload, shared ? 1 : 0, now, now);
      return get(id)!;
    },
    findById: get,
    listForOwner: (ownerId) => visible.all(ownerId) as DashboardRow[],
    listAll: () => all.all() as DashboardRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      db.prepare('UPDATE dashboards SET name = ?, payload = ?, shared = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? cur.name, patch.payload ?? cur.payload, patch.shared ? 1 : patch.shared === false ? 0 : cur.shared, Date.now(), id);
      return get(id);
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
