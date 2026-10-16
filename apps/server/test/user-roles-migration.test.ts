import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

const LEGACY_USERS_DDL = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

function insertLegacyUser(db: Database.Database, id: string, username: string, role: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, username, 'hash', role, 'active', 1000, 1000);
}

function rolesOf(db: Database.Database, userId: string): string[] {
  return (db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId) as Array<{ role: string }>)
    .map((r) => r.role)
    .sort();
}

describe('user_roles 迁移与回填', () => {
  it('老库回填 user_roles', () => {
    const db = new Database(':memory:');
    db.exec(LEGACY_USERS_DDL);
    insertLegacyUser(db, 'u-admin', 'admin', 'admin');
    insertLegacyUser(db, 'u-user', 'user', 'user');

    migrate(db);

    expect(rolesOf(db, 'u-admin')).toEqual(['admin']);
    expect(rolesOf(db, 'u-user')).toEqual(['workflow_author']);

    const legacyRole = db.prepare('SELECT role FROM users WHERE id = ?').get('u-user') as { role: string };
    expect(legacyRole.role).toBe('user');
  });

  it('回填幂等', () => {
    const db = new Database(':memory:');
    db.exec(LEGACY_USERS_DDL);
    insertLegacyUser(db, 'u-admin', 'admin', 'admin');
    insertLegacyUser(db, 'u-user', 'user', 'user');

    migrate(db);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number }).c;

    migrate(db);
    const after = (db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number }).c;

    expect(after).toBe(before);
  });

  it('新库 users.role 默认值为 workflow_author', () => {
    const db = new Database(':memory:');
    migrate(db);

    db.prepare(
      'INSERT INTO users (id, username, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('u-new', 'new', 'hash', 'active', 1000, 1000);

    const row = db.prepare('SELECT role FROM users WHERE id = ?').get('u-new') as { role: string };
    expect(row.role).toBe('workflow_author');
  });
});
