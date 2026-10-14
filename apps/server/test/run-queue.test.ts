import { describe, expect, it } from 'vitest';
import { createSemaphore } from '../src/modules/runs/queue.js';

describe('createSemaphore', () => {
  it('并发不超过 limit，且峰值正确', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(sem.active()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  it('release 后把槽位交给等待者', async () => {
    const sem = createSemaphore(1);
    const order: string[] = [];
    const p1 = sem.run(async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a:end');
    });
    const p2 = sem.run(async () => {
      order.push('b:start');
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(sem.waiting()).toBe(1);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('fn 抛错时也会释放槽位', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sem.active()).toBe(0);
  });
});
