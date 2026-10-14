import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { usersRepo, type UsersRepo } from '../src/modules/users/repo.js';
import { sessionsRepo, type SessionsRepo } from '../src/modules/auth/sessions.js';

let db: Database.Database;
let users: UsersRepo;
let sessions: SessionsRepo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  users = usersRepo(db);
  sessions = sessionsRepo(db);
});

describe('usersRepo', () => {
  it('创建与按名查询', () => {
    const u = users.create({ username: 'alice', passwordHash: 'h', role: 'user' });
    expect(u.id).toBeTruthy();
    expect(users.findByUsername('alice')?.id).toBe(u.id);
    expect(users.count()).toBe(1);
  });

  it('用户名唯一', () => {
    users.create({ username: 'alice', passwordHash: 'h', role: 'user' });
    expect(() => users.create({ username: 'alice', passwordHash: 'h', role: 'user' })).toThrow();
  });

  it('修改角色与状态', () => {
    const u = users.create({ username: 'bob', passwordHash: 'h', role: 'user' });
    const updated = users.update(u.id, { role: 'admin', status: 'disabled' });
    expect(updated?.role).toBe('admin');
    expect(updated?.status).toBe('disabled');
  });

  it('删除用户级联清理会话', () => {
    const u = users.create({ username: 'carol', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 10_000);
    users.remove(u.id);
    expect(sessions.findValid(s.token)).toBeNull();
  });
});

describe('sessionsRepo', () => {
  it('创建后可校验', () => {
    const u = users.create({ username: 'dave', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 10_000);
    expect(sessions.findValid(s.token)?.user_id).toBe(u.id);
  });

  it('过期即失效并清理', () => {
    const u = users.create({ username: 'eve', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 1000);
    expect(sessions.findValid(s.token, Date.now() + 5000)).toBeNull();
  });

  it('登出移除会话', () => {
    const u = users.create({ username: 'frank', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 10_000);
    sessions.remove(s.token);
    expect(sessions.findValid(s.token)).toBeNull();
  });
});
