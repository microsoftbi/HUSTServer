import cron from 'node-cron';
import type { ScheduleRow, SchedulesRepo } from './repo.js';

/** 对 node-cron 定时任务的最小抽象。 */
export interface CronTask {
  stop(): void;
  destroy(): void;
}

/** 对 node-cron 的最小抽象，便于测试注入。 */
export interface CronImpl {
  schedule(expr: string, timezone: string, fn: () => void): CronTask | null;
}

export interface SchedulerDeps {
  schedules: SchedulesRepo;
  triggerRun: (workflowId: string, scheduleId: string) => void;
  cronImpl?: CronImpl;
  onError?: (err: unknown) => void;
}

export interface Scheduler {
  /** 启动：全量重建全部启用调度 */
  start(): void;
  /** 停止并销毁全部任务 */
  stop(): void;
  /** 热更新：等价于 stop + start */
  reload(): void;
  /** 当前已注册的调度 id（测试与诊断用） */
  registeredIds(): string[];
}

const defaultCronImpl: CronImpl = {
  schedule(expr, timezone, fn) {
    if (!cron.validate(expr)) return null;
    const task = cron.schedule(expr, fn, { scheduled: true, timezone });
    return { stop: () => task.stop(), destroy: () => task.stop() };
  },
};

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const impl = deps.cronImpl ?? defaultCronImpl;
  const tasks = new Map<string, CronTask>();

  const stopAll = (): void => {
    for (const task of tasks.values()) task.destroy();
    tasks.clear();
  };

  const register = (schedule: ScheduleRow): void => {
    const task = impl.schedule(schedule.cron_expr, schedule.timezone, () => {
      try {
        deps.triggerRun(schedule.workflow_id, schedule.id);
      } catch (err) {
        deps.onError?.(err);
      }
    });
    if (task) tasks.set(schedule.id, task);
  };

  const reload = (): void => {
    stopAll();
    for (const schedule of deps.schedules.listEnabled()) register(schedule);
  };

  return {
    start: reload,
    stop: stopAll,
    reload,
    registeredIds: () => [...tasks.keys()],
  };
}
