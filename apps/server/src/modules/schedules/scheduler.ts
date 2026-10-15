import cron from 'node-cron';

/** 对 node-cron 定时任务的最小抽象。 */
export interface CronTask {
  stop(): void;
  destroy(): void;
}

/** 对 node-cron 的最小抽象，便于测试注入。 */
export interface CronImpl {
  schedule(expr: string, timezone: string, fn: () => void): CronTask | null;
}

/** 一条 cron 注册项：id 为唯一键（scheduleId 或 jobId）。 */
export interface CronEntry {
  id: string;
  expr: string;
  timezone: string;
}

export interface SchedulerDeps {
  cronImpl?: CronImpl;
  onError?: (err: unknown) => void;
}

export interface Scheduler {
  /** 记录 (entries, onFire) 并全量重建定时器；不在新集合内的旧任务被销毁。 */
  sync(entries: CronEntry[], onFire: (id: string) => void): void;
  /** 用最近一次 sync 记录的 (entries, onFire) 重建定时器；从未 sync 过则 no-op。 */
  start(): void;
  /** 销毁全部定时器（不遗忘最近一次 sync 的参数）。 */
  stop(): void;
  /** 当前已注册的 id（测试与诊断用）。 */
  registeredIds(): string[];
}

const defaultCronImpl: CronImpl = {
  schedule(expr, timezone, fn) {
    if (!cron.validate(expr)) return null;
    const task = cron.schedule(expr, fn, { scheduled: true, timezone });
    return { stop: () => task.stop(), destroy: () => task.stop() };
  },
};

export function createScheduler(deps: SchedulerDeps = {}): Scheduler {
  const impl = deps.cronImpl ?? defaultCronImpl;
  const tasks = new Map<string, CronTask>();
  let lastEntries: CronEntry[] = [];
  let lastOnFire: ((id: string) => void) | null = null;

  const stopAll = (): void => {
    for (const task of tasks.values()) task.destroy();
    tasks.clear();
  };

  const rebuild = (): void => {
    stopAll();
    if (!lastOnFire) return;
    for (const entry of lastEntries) {
      const task = impl.schedule(entry.expr, entry.timezone, () => {
        try {
          lastOnFire!(entry.id);
        } catch (err) {
          deps.onError?.(err);
        }
      });
      if (task) tasks.set(entry.id, task);
    }
  };

  return {
    sync(entries, onFire) {
      lastEntries = entries;
      lastOnFire = onFire;
      rebuild();
    },
    start: rebuild,
    stop: stopAll,
    registeredIds: () => [...tasks.keys()],
  };
}
