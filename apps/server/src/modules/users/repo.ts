import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type Role = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: number;
  updated_at: number;
}

export interface UsersRepo {
  findById(id: string): UserRow | null;
  findByUsername(username: string): UserRow | null;
  list(): UserRow[];
  create(input: { username: string; passwordHash: string; role: Role }): UserRow;
  update(id: string, patch: { role?: Role; status?: UserStatus; passwordHash?: string }): UserRow | null;
  remove(id: string): boolean;
  count(): number;
}

export function usersRepo(db: Database): UsersRepo {
  const findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const findByNameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const listStmt = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  const insertStmt = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM users');
  const deleteStmt = db.prepare('DELETE FROM users WHERE id = ?');

  function get(id: string): UserRow | null {
    return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
  }

  return {
    findById: get,
    findByUsername: (username) => (findByNameStmt.get(username) as UserRow | undefined) ?? null,
    list: () => listStmt.all() as UserRow[],
    create({ username, passwordHash, role }) {
      const now = Date.now();
      const id = nanoid(12);
      insertStmt.run(id, username, passwordHash, role, 'active', now, now);
      return get(id)!;
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const next = {
        role: patch.role ?? current.role,
        status: patch.status ?? current.status,
        password_hash: patch.passwordHash ?? current.password_hash,
      };
      db.prepare('UPDATE users SET role = ?, status = ?, password_hash = ?, updated_at = ? WHERE id = ?')
        .run(next.role, next.status, next.password_hash, Date.now(), id);
      return get(id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
    count: () => Number((countStmt.get() as { c: number }).c),
  };
}
