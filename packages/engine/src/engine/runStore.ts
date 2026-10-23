import type { ServerResponse } from 'node:http';
import { nanoid } from 'nanoid';
import { RUN_TTL_MS } from '../config.js';
import type {
  NodeResultEvent,
  NodeRunStatus,
  RunLogEvent,
  RunStatusEvent,
  SseEvent,
  Workflow,
} from '../types.js';
import { closeSession, createSession, type DuckSession } from './duckdb.js';
import type { ModelWriteHook } from '../nodes/context.js';

export interface NodeResultState {
  status: NodeRunStatus;
  rowCount: number;
  durationMs: number;
  error?: string;
}

export interface RunContext {
  runId: string;
  workflow: Workflow;
  /** 「运行至此」的目标节点；为空表示全量运行。 */
  targetNodeId?: string;
  session: DuckSession;
  status: 'running' | 'success' | 'error';
  nodeStatus: Map<string, NodeRunStatus>;
  nodeResults: Map<string, NodeResultState>;
  subscribers: Set<ServerResponse>;
  events: SseEvent[];
  createdAt: number;
  lastAccess: number;
  /** 是否拥有 session 的所有权；复用缓存运行时为 false，销毁时不关闭共享会话。 */
  ownsSession: boolean;
  /** 「缓存至此」运行：成功后钉住本次会话。 */
  freeze?: boolean;
  /** 「缓存至此」为本次运行分配的缓存令牌。 */
  cacheToken?: string;
  /** 复用缓存运行：这些节点直接沿用缓存结果，跳过执行。 */
  skipNodeIds?: Set<string>;
  /** 宿主注入的「写出数据模型」能力。 */
  writeModel?: ModelWriteHook;
  /** 已被钉住（缓存），不随 TTL 回收。 */
  pinned?: boolean;
}

/** 被钉住（冻结）的缓存：会话与其上游节点结果在会话存活期内长期保留。 */
export interface PinnedCache {
  cacheToken: string;
  runId: string;
  boundaryNodeId: string;
  cachedNodeIds: Set<string>;
  results: Map<string, NodeResultState>;
  session: DuckSession;
}

/** 创建运行时可选参数：冻结缓存 / 复用缓存。 */
export interface CreateRunOptions {
  /** 「缓存至此」：本次运行成功后钉住会话。 */
  freezeToken?: string;
  /** 复用已有缓存：跳过缓存节点并共享其会话。 */
  reuseToken?: string;
  /** 宿主注入的「写出数据模型」能力。 */
  writeModel?: ModelWriteHook;
}

/** 复用缓存时令牌已失效（后端重启或已取消缓存）。 */
export class CacheExpiredError extends Error {
  code = 'CACHE_EXPIRED';
  constructor() {
    super('缓存已失效');
    this.name = 'CacheExpiredError';
  }
}

const MAX_BUFFERED_EVENTS = 5000;

/** 外部事件 sink：本平台用于 Recorder 落库；不改变原有内存语义与 SSE 行为。 */
export type RunEventSink = (ctx: RunContext, event: SseEvent) => void;
const eventSinks = new Set<RunEventSink>();
/** 注册一个事件 sink，返回取消注册的函数。 */
export function registerEventSink(sink: RunEventSink): () => void {
  eventSinks.add(sink);
  return () => {
    eventSinks.delete(sink);
  };
}

const runs = new Map<string, RunContext>();
/** 已钉住的缓存，键为缓存令牌。 */
const pinnedCaches = new Map<string, PinnedCache>();
let evictor: NodeJS.Timeout | null = null;

function startEvictor(): void {
  if (evictor) return;
  evictor = setInterval(() => {
    const now = Date.now();
    for (const [runId, ctx] of runs.entries()) {
      // 被钉住的缓存会话不回收，提供给后续运行复用。
      if (ctx.pinned) continue;
      if (now - ctx.lastAccess > RUN_TTL_MS) {
        disposeRun(runId);
      }
    }
  }, 60_000);
  evictor.unref?.();
}

export async function createRun(
  workflow: Workflow,
  targetNodeId?: string,
  options?: CreateRunOptions,
): Promise<RunContext> {
  startEvictor();
  const now = Date.now();

  // 复用缓存：共享被钉住会话，缓存节点直接沿用成功结果。
  if (options?.reuseToken) {
    const cache = pinnedCaches.get(options.reuseToken);
    if (!cache) throw new CacheExpiredError();
    const ctx: RunContext = {
      runId: nanoid(12),
      workflow,
      session: cache.session,
      status: 'running',
      nodeStatus: new Map(),
      nodeResults: new Map(),
      subscribers: new Set(),
      events: [],
      createdAt: now,
      lastAccess: now,
      ownsSession: false,
      skipNodeIds: new Set(cache.cachedNodeIds),
      ...(options.writeModel ? { writeModel: options.writeModel } : {}),
    };
    for (const node of workflow.nodes) {
      const cached = cache.results.get(node.id);
      if (cached && cache.cachedNodeIds.has(node.id)) {
        ctx.nodeStatus.set(node.id, 'success');
        ctx.nodeResults.set(node.id, { ...cached });
      } else {
        ctx.nodeStatus.set(node.id, 'pending');
      }
    }
    runs.set(ctx.runId, ctx);
    return ctx;
  }

  const session = await createSession();
  const ctx: RunContext = {
    runId: nanoid(12),
    workflow,
    targetNodeId,
    session,
    status: 'running',
    nodeStatus: new Map(),
    nodeResults: new Map(),
    subscribers: new Set(),
    events: [],
    createdAt: now,
    lastAccess: now,
    ownsSession: true,
    ...(options?.freezeToken ? { freeze: true, cacheToken: options.freezeToken } : {}),
    ...(options?.writeModel ? { writeModel: options.writeModel } : {}),
  };
  for (const node of workflow.nodes) {
    ctx.nodeStatus.set(node.id, 'pending');
  }
  runs.set(ctx.runId, ctx);
  return ctx;
}

/** 「缓存至此」成功后钉住本次运行的会话，返回缓存条目。 */
export function pinRun(
  runId: string,
  cachedNodeIds: Set<string>,
  boundaryNodeId: string,
): PinnedCache | null {
  const ctx = runs.get(runId);
  if (!ctx || !ctx.cacheToken) return null;
  ctx.pinned = true;
  const results = new Map<string, NodeResultState>();
  for (const id of cachedNodeIds) {
    const result = ctx.nodeResults.get(id);
    if (result) results.set(id, { ...result });
  }
  const cache: PinnedCache = {
    cacheToken: ctx.cacheToken,
    runId,
    boundaryNodeId,
    cachedNodeIds: new Set(cachedNodeIds),
    results,
    session: ctx.session,
  };
  pinnedCaches.set(ctx.cacheToken, cache);
  return cache;
}

export function getPinnedCache(cacheToken: string): PinnedCache | null {
  return pinnedCaches.get(cacheToken) ?? null;
}

/** 取消缓存：关闭被钉住的会话并清理所有共享该会话的运行。 */
export function unpinCache(cacheToken: string): boolean {
  const cache = pinnedCaches.get(cacheToken);
  if (!cache) return false;
  pinnedCaches.delete(cacheToken);
  for (const [runId, ctx] of runs.entries()) {
    if (ctx.session === cache.session) disposeRun(runId);
  }
  return true;
}

export function getRun(runId: string): RunContext | null {
  const ctx = runs.get(runId);
  if (ctx) ctx.lastAccess = Date.now();
  return ctx ?? null;
}

export function disposeRun(runId: string): void {
  const ctx = runs.get(runId);
  if (!ctx) return;
  for (const res of ctx.subscribers) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  // 复用缓存运行不拥有会话，避免误关被钉住的共享会话。
  if (ctx.ownsSession) closeSession(ctx.session);
  runs.delete(runId);
}

export function subscribe(runId: string, res: ServerResponse): boolean {
  const ctx = getRun(runId);
  if (!ctx) return false;
  ctx.lastAccess = Date.now();
  for (const event of ctx.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  ctx.subscribers.add(res);
  res.on('close', () => {
    ctx.subscribers.delete(res);
  });
  return true;
}

export function publishEvent(ctx: RunContext, event: SseEvent): void {
  ctx.lastAccess = Date.now();
  ctx.events.push(event);
  if (ctx.events.length > MAX_BUFFERED_EVENTS) {
    ctx.events.splice(0, ctx.events.length - MAX_BUFFERED_EVENTS);
  }
  for (const sink of eventSinks) {
    try {
      sink(ctx, event);
    } catch {
      /* sink 异常不得影响运行 */
    }
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of ctx.subscribers) {
    try {
      res.write(payload);
    } catch {
      ctx.subscribers.delete(res);
    }
  }
}

export function publishLog(
  ctx: RunContext,
  level: RunLogEvent['level'],
  message: string,
  nodeId?: string,
): void {
  publishEvent(ctx, { runId: ctx.runId, nodeId, level, message, ts: Date.now() });
}

export function publishNodeResult(
  ctx: RunContext,
  nodeId: string,
  status: NodeRunStatus,
  rowCount: number,
  durationMs: number,
  error?: string,
): void {
  const event: NodeResultEvent = {
    runId: ctx.runId,
    type: 'node-result',
    nodeId,
    status,
    rowCount,
    durationMs,
    error,
  };
  publishEvent(ctx, event);
}

export function publishRunStatus(
  ctx: RunContext,
  status: RunStatusEvent['status'],
  message?: string,
): void {
  publishEvent(ctx, { runId: ctx.runId, type: 'run-status', status, message });
}

export function listRuns(): Array<Pick<RunContext, 'runId' | 'status' | 'createdAt'>> {
  return [...runs.values()].map((ctx) => ({
    runId: ctx.runId,
    status: ctx.status,
    createdAt: ctx.createdAt,
  }));
}
