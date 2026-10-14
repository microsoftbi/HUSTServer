export type Release = () => void;

export interface Semaphore {
  acquire(): Promise<Release>;
  run<T>(fn: () => Promise<T>): Promise<T>;
  active(): number;
  waiting(): number;
}

export function createSemaphore(limit: number): Semaphore {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const release: Release = () => {
    const next = queue.shift();
    if (next) {
      // 先归还当前槽位再授予等待者，active 保持不变
      active -= 1;
      next();
      return;
    }
    active -= 1;
  };

  const acquire = (): Promise<Release> =>
    new Promise<Release>((resolve) => {
      const grant = (): void => {
        active += 1;
        resolve(release);
      };
      if (active < max) grant();
      else queue.push(grant);
    });

  return {
    acquire,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const rel = await acquire();
      try {
        return await fn();
      } finally {
        rel();
      }
    },
    active: () => active,
    waiting: () => queue.length,
  };
}
