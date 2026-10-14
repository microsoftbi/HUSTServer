import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { ensureBootstrapAdmin } from '../src/bootstrap.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { verifyPassword } from '../src/modules/auth/password.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

describe('ensureBootstrapAdmin', () => {
  it('空库创建初始管理员', async () => {
    const db = new Database(':memory:');
    migrate(db);
    await ensureBootstrapAdmin(db, { ...cfg, bootstrapAdminUser: 'root', bootstrapAdminPassword: 'root123' }, { info() {}, warn() {} });
    const admin = usersRepo(db).findByUsername('root');
    expect(admin?.role).toBe('admin');
    expect(await verifyPassword('root123', admin!.password_hash)).toBe(true);
  });

  it('库非空时不重复创建', async () => {
    const db = new Database(':memory:');
    migrate(db);
    await ensureBootstrapAdmin(db, { ...cfg, bootstrapAdminUser: 'root', bootstrapAdminPassword: 'root123' }, { info() {}, warn() {} });
    await ensureBootstrapAdmin(db, { ...cfg, bootstrapAdminUser: 'root2', bootstrapAdminPassword: 'root123' }, { info() {}, warn() {} });
    expect(usersRepo(db).count()).toBe(1);
  });
});
