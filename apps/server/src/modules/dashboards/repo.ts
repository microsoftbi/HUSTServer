import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface DashboardRow {
  id: string;
  owner_id: string | null;
  name: string;
  payload: string;
  created_at: number;
  updated_at: number;
}

export interface DashboardsRepo {
  create(input: { ownerId: string; name: string; payload: string }): DashboardRow;
  findById(id: string): DashboardRow | null;
  listAll(): DashboardRow[];
  update(id: string, patch: { name?: string; payload?: string }): DashboardRow | null;
  remove(id: string): boolean;
}

export function dashboardsRepo(db: Database): DashboardsRepo {
  const insert = db.prepare('INSERT INTO dashboards (id, owner_id, name, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM dashboards WHERE id = ?');
  const all = db.prepare('SELECT * FROM dashboards ORDER BY created_at DESC');
  const del = db.prepare('DELETE FROM dashboards WHERE id = ?');
  const get = (id: string) => (byId.get(id) as DashboardRow | undefined) ?? null;

  return {
    create({ ownerId, name, payload }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, payload, now, now);
      return get(id)!;
    },
    findById: get,
    listAll: () => all.all() as DashboardRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      db.prepare('UPDATE dashboards SET name = ?, payload = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? cur.name, patch.payload ?? cur.payload, Date.now(), id);
      return get(id);
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
