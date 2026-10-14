import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { settingsRepo } from '../src/modules/settings/repo.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('settingsRepo', () => {
  it('set/get 往返，缺失返回 null', () => {
    const repo = settingsRepo(db);
    expect(repo.get('maxConcurrentRuns')).toBeNull();
    repo.set('maxConcurrentRuns', '4');
    expect(repo.get('maxConcurrentRuns')).toBe('4');
  });

  it('set 覆盖已存在键（upsert）', () => {
    const repo = settingsRepo(db);
    repo.set('tz', 'UTC');
    repo.set('tz', 'Asia/Shanghai');
    expect(repo.get('tz')).toBe('Asia/Shanghai');
  });

  it('all 返回全部键值', () => {
    const repo = settingsRepo(db);
    repo.set('a', '1');
    repo.set('b', '2');
    expect(repo.all()).toEqual({ a: '1', b: '2' });
  });

  it('setMany 原子写入多条', () => {
    const repo = settingsRepo(db);
    repo.setMany({ maxConcurrentRuns: '3', logRetentionDays: '30' });
    expect(repo.all()).toEqual({ maxConcurrentRuns: '3', logRetentionDays: '30' });
  });
});
