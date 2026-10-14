import type { RunsRepo } from './repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保留期清理依赖：运行仓储 + 保留天数 + 可注入时钟（测试用）。 */
export interface RetentionDeps {
  runs: RunsRepo;
  logRetentionDays: number;
  now?: () => number;
}

/**
 * 删除创建时间早于 `now - logRetentionDays` 的运行记录。
 * runs 表对 run_node_results / run_logs 均为 ON DELETE CASCADE，删除主记录即级联清理。
 * @returns 实际删除的运行条数
 */
export function pruneRuns(deps: RetentionDeps): number {
  const now = deps.now ?? Date.now;
  const cutoff = now() - deps.logRetentionDays * DAY_MS;
  const stale = deps.runs.listOlderThan(cutoff);
  let removed = 0;
  for (const run of stale) {
    if (deps.runs.remove(run.id)) removed += 1;
  }
  return removed;
}

/** 可运行的保留期清理器：手动 run 或按固定间隔 start。 */
export interface Retention {
  run(): number;
  start(intervalMs?: number): void;
  stop(): void;
}

export interface RetentionRuntimeDeps extends RetentionDeps {
  /** 默认 24h 触发一次 */
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export function createRetention(deps: RetentionRuntimeDeps): Retention {
  let timer: NodeJS.Timeout | null = null;

  const run = (): number => {
    try {
      return pruneRuns(deps);
    } catch (err) {
      deps.onError?.(err);
      return 0;
    }
  };

  return {
    run,
    start(intervalMs = deps.intervalMs ?? DAY_MS) {
      if (timer) return;
      timer = setInterval(run, intervalMs);
      // 定时器不阻塞进程退出（与 Scheduler 一致）
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
