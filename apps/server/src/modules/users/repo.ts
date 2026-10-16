import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { Role } from './roles.js';
import { primaryRole } from './roles.js';

export type { Role } from './roles.js';

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
  rolesOf(userId: string): Role[];
  setRoles(userId: string, roles: Role[]): void;
  create(input: { username: string; passwordHash: string; roles: Role[] }): UserRow;
  update(id: string, patch: { roles?: Role[]; status?: UserStatus; passwordHash?: string }): UserRow | null;
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
  const rolesStmt = db.prepare('SELECT role FROM user_roles WHERE user_id = ?');
  const insertRoleStmt = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)');
  const deleteRolesStmt = db.prepare('DELETE FROM user_roles WHERE user_id = ?');
  const mirrorStmt = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const updateStmt = db.prepare(
    'UPDATE users SET role = ?, status = ?, password_hash = ?, updated_at = ? WHERE id = ?',
  );

  function get(id: string): UserRow | null {
    return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
  }

  function rolesOf(userId: string): Role[] {
    return (rolesStmt.all(userId) as { role: Role }[]).map((r) => r.role);
  }

  function setRoles(userId: string, roles: Role[]): void {
    const tx = db.transaction(() => {
      deleteRolesStmt.run(userId);
      for (const role of roles) insertRoleStmt.run(userId, role);
      mirrorStmt.run(primaryRole(roles), userId);
    });
    tx();
  }

  return {
    findById: get,
    findByUsername: (username) => (findByNameStmt.get(username) as UserRow | undefined) ?? null,
    list: () => listStmt.all() as UserRow[],
    rolesOf,
    setRoles,
    create({ username, passwordHash, roles }) {
      const now = Date.now();
      const id = nanoid(12);
      const tx = db.transaction(() => {
        insertStmt.run(id, username, passwordHash, primaryRole(roles), 'active', now, now);
        for (const role of roles) insertRoleStmt.run(id, role);
      });
      tx();
      return get(id)!;
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const nextRole = patch.roles ? primaryRole(patch.roles) : current.role;
      const status = patch.status ?? current.status;
      const password_hash = patch.passwordHash ?? current.password_hash;
      const tx = db.transaction(() => {
        if (patch.roles) {
          deleteRolesStmt.run(id);
          for (const role of patch.roles) insertRoleStmt.run(id, role);
        }
        updateStmt.run(nextRole, status, password_hash, Date.now(), id);
      });
      tx();
      return get(id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
    count: () => Number((countStmt.get() as { c: number }).c),
  };
}
