import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
};

describe('loadConfig', () => {
  it('读取并推导默认值', () => {
    const cfg = loadConfig(base);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8787);
    expect(cfg.dbFile).toBe('/tmp/hustserver-test/metadata.sqlite');
    expect(cfg.modelDbFile).toBe('/tmp/hustserver-test/models.duckdb');
    expect(cfg.uploadDir).toBe('/tmp/hustserver-test/uploads');
    expect(cfg.resourceDir).toBe('/tmp/hustserver-test/resources');
    expect(cfg.encryptionKey.length).toBe(32);
    expect(cfg.tz).toBe('Asia/Shanghai');
    expect(cfg.maxConcurrentRuns).toBe(2);
  });

  it('缺少 SESSION_SECRET 抛错', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: '' })).toThrow('SESSION_SECRET');
  });

  it('ENCRYPTION_KEY 非法抛错', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow('ENCRYPTION_KEY');
  });

  it('解析共享目录列表', () => {
    const cfg = loadConfig({ ...base, HUSTSERVER_SHARED_DIRS: '/data/a, /data/b ,' });
    expect(cfg.sharedDirs).toEqual(['/data/a', '/data/b']);
  });

  it('HUSTSERVER_WEB_DIR 覆盖前端产物目录', () => {
    const cfg = loadConfig({ ...base, HUSTSERVER_WEB_DIR: '/app/Resources/web' });
    expect(cfg.webDir).toBe('/app/Resources/web');
    expect(loadConfig(base).webDir.endsWith('/web/dist')).toBe(true);
  });
});
