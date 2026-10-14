import { describe, expect, it } from 'vitest';
import {
  publishEvent,
  registerEventSink,
  type RunContext,
} from '../src/engine/runStore.js';
import type { RunLogEvent } from '../src/types.js';

function fakeCtx(): RunContext {
  return {
    runId: 'engine-run-1',
    workflow: { id: 'w1', name: 'w', nodes: [], edges: [], createdAt: 0, updatedAt: 0 },
    session: {} as RunContext['session'],
    status: 'running',
    nodeStatus: new Map(),
    nodeResults: new Map(),
    subscribers: new Set(),
    events: [],
    createdAt: 0,
    lastAccess: 0,
    ownsSession: false,
  };
}

describe('runStore 事件 sink', () => {
  it('注册的 sink 能收到 publishEvent 广播，取消后不再收到', () => {
    const ctx = fakeCtx();
    const seen: string[] = [];
    const off = registerEventSink((_ctx, event) => {
      seen.push(event.runId);
    });
    const event: RunLogEvent = { runId: 'engine-run-1', level: 'info', message: 'hi', ts: 1 };
    publishEvent(ctx, event);
    off();
    publishEvent(ctx, event);
    expect(seen).toEqual(['engine-run-1']);
  });

  it('sink 抛错不影响事件缓冲', () => {
    const ctx = fakeCtx();
    const off = registerEventSink(() => {
      throw new Error('boom');
    });
    publishEvent(ctx, { runId: 'engine-run-1', level: 'info', message: 'x', ts: 2 });
    off();
    expect(ctx.events).toHaveLength(1);
  });
});
