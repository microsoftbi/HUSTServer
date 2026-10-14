import { describe, expect, it, vi } from 'vitest';
import type { ScheduleRow, SchedulesRepo } from '../src/modules/schedules/repo.js';
import { createScheduler, type CronImpl } from '../src/modules/schedules/scheduler.js';

function row(over: Partial<ScheduleRow> & { id: string }): ScheduleRow {
  return {
    workflow_id: 'w1',
    enabled: 1,
    freq_type: 'daily',
    cron_expr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

/** 捕获注册信息的桩 CronImpl。 */
function stubCron() {
  const registered: Array<{ expr: string; tz: string; fire: () => void }> = [];
  const impl: CronImpl = {
    schedule(expr, timezone, fn) {
      if (expr === 'INVALID') return null;
      registered.push({ expr, tz: timezone, fire: fn });
      return { stop: () => {}, destroy: () => {} };
    },
  };
  return { registered, impl };
}

describe('createScheduler', () => {
  it('start 注册全部启用调度', () => {
    const { registered, impl } = stubCron();
    const schedules = {
      listEnabled: () => [row({ id: 's1' }), row({ id: 's2', cron_expr: '0 3 * * *' })],
    } as unknown as SchedulesRepo;
    const s = createScheduler({ schedules, triggerRun: vi.fn(), cronImpl: impl });

    s.start();
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(registered.map((r) => r.expr)).toEqual(['0 9 * * *', '0 3 * * *']);
    expect(registered[0].tz).toBe('Asia/Shanghai');
  });

  it('定时回调触发 triggerRun(workflowId, scheduleId)', () => {
    const { registered, impl } = stubCron();
    const schedules = {
      listEnabled: () => [row({ id: 's1', workflow_id: 'w9' })],
    } as unknown as SchedulesRepo;
    const triggerRun = vi.fn();
    const s = createScheduler({ schedules, triggerRun, cronImpl: impl });

    s.start();
    registered[0].fire();
    expect(triggerRun).toHaveBeenCalledWith('w9', 's1');
  });

  it('triggerRun 抛错时交由 onError，不向外抛出', () => {
    const { registered, impl } = stubCron();
    const schedules = { listEnabled: () => [row({ id: 's1' })] } as unknown as SchedulesRepo;
    const onError = vi.fn();
    const s = createScheduler({
      schedules,
      triggerRun: () => {
        throw new Error('boom');
      },
      cronImpl: impl,
      onError,
    });

    s.start();
    expect(() => registered[0].fire()).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reload 反映最新启用集合并销毁旧任务；stop 清空', () => {
    const { impl } = stubCron();
    let rows: ScheduleRow[] = [row({ id: 's1' })];
    const destroyed: string[] = [];
    const implWithSpy: CronImpl = {
      schedule: (expr, tz, fn) => {
        const task = impl.schedule(expr, tz, fn)!;
        return {
          stop: () => task.stop(),
          destroy: () => {
            destroyed.push(expr);
            task.destroy();
          },
        };
      },
    };
    const schedules = { listEnabled: () => rows.filter((r) => r.enabled === 1) } as unknown as SchedulesRepo;
    const s = createScheduler({ schedules, triggerRun: vi.fn(), cronImpl: implWithSpy });

    s.start();
    expect(s.registeredIds()).toEqual(['s1']);
    rows = [row({ id: 's1' }), row({ id: 's2' }), row({ id: 's3', enabled: 0 })];
    s.reload();
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(destroyed.length).toBeGreaterThanOrEqual(1); // 旧任务被销毁

    s.stop();
    expect(s.registeredIds()).toEqual([]);
  });

  it('非法 cron 表达式不注册', () => {
    const { impl } = stubCron();
    const schedules = {
      listEnabled: () => [row({ id: 's1', cron_expr: 'INVALID' })],
    } as unknown as SchedulesRepo;
    const s = createScheduler({ schedules, triggerRun: vi.fn(), cronImpl: impl });
    s.start();
    expect(s.registeredIds()).toEqual([]);
  });
});
