import { describe, expect, it, vi } from 'vitest';
import { createScheduler, type CronEntry, type CronImpl } from '../src/modules/schedules/scheduler.js';

function entry(over: Partial<CronEntry> & { id: string }): CronEntry {
  return { expr: '0 9 * * *', timezone: 'Asia/Shanghai', ...over };
}

/** 捕获注册信息的桩 CronImpl；'INVALID' 表达式视为非法不注册。 */
function stubCron() {
  const registered: Array<{ expr: string; tz: string; fire: () => void }> = [];
  const destroyed: string[] = [];
  const impl: CronImpl = {
    schedule(expr, timezone, fn) {
      if (expr === 'INVALID') return null;
      registered.push({ expr, tz: timezone, fire: fn });
      return { stop: () => {}, destroy: () => destroyed.push(expr) };
    },
  };
  return { registered, destroyed, impl };
}

describe('createScheduler（sync 泛化版）', () => {
  it('sync 后 registeredIds 与传入 entries 一致', () => {
    const { registered, impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' }), entry({ id: 's2', expr: '0 3 * * *' })], () => {});
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(registered.map((r) => r.expr)).toEqual(['0 9 * * *', '0 3 * * *']);
    expect(registered[0].tz).toBe('Asia/Shanghai');
  });

  it('fire 回调收到对应 id；onError 捕获不向外抛出', () => {
    const { registered, impl } = stubCron();
    const onFire = vi.fn();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' })], onFire);
    registered[0].fire();
    expect(onFire).toHaveBeenCalledWith('s1');

    const onError = vi.fn();
    const s2 = createScheduler({
      cronImpl: impl,
      onError,
    });
    s2.sync([entry({ id: 'boom' })], () => {
      throw new Error('x');
    });
    expect(() => registered[1].fire()).not.toThrow(); // registered[1] 是 s2 刚注册的 'boom'
    expect(onError).toHaveBeenCalledOnce();
  });

  it('再次 sync 全量重建并销毁旧任务', () => {
    const { destroyed, impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' })], () => {});
    expect(s.registeredIds()).toEqual(['s1']);
    s.sync([entry({ id: 's1' }), entry({ id: 's2' })], () => {});
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    s.sync([entry({ id: 's2' })], () => {});
    expect(s.registeredIds()).toEqual(['s2']);
  });

  it('stop 清空；start 重放最近一次 sync', () => {
    const { impl } = stubCron();
    const onFire = vi.fn();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' })], onFire);
    s.stop();
    expect(s.registeredIds()).toEqual([]);
    s.start();
    expect(s.registeredIds()).toEqual(['s1']);
  });

  it('从未 sync 时 start 为 no-op', () => {
    const { registered, impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.start();
    expect(s.registeredIds()).toEqual([]);
    expect(registered).toHaveLength(0);
  });

  it('非法 cron 表达式不注册', () => {
    const { impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1', expr: 'INVALID' })], () => {});
    expect(s.registeredIds()).toEqual([]);
  });
});
