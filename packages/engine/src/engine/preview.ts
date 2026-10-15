/**
 * 运行后节点输出预览：在运行上下文（会话）存活期内，读取某节点输出表的前 N 行。
 *
 * 运行结束后 DuckDB 会话不会立即销毁，会随运行上下文保留 RUN_TTL_MS，
 * 因此这里无需任何额外持久化，直接复用 `getRun` 拿到的会话连接即可。
 */
import { PREVIEW_DEFAULT_LIMIT, PREVIEW_MAX_LIMIT } from '../config.js';
import type { PreviewResult } from '../types.js';
import { quoteIdent, tableNameForNode } from '../util/sqlIdent.js';
import { toJsonSafeRow } from '../util/values.js';
import { describeTable } from './duckdb.js';
import { getRun } from './runStore.js';

/** 运行不存在或已过期（会话已被 TTL 回收）。 */
export class RunExpiredError extends Error {
  code = 'RUN_EXPIRED';
  constructor() {
    super('运行不存在或已过期');
    this.name = 'RunExpiredError';
  }
}

/** 该节点尚无可用输出（未执行 / 执行失败 / 已跳过）。 */
export class NodeNotReadyError extends Error {
  code = 'NODE_NOT_READY';
  detail: string;
  constructor(detail: string) {
    super('该阶段尚无可用数据');
    this.name = 'NodeNotReadyError';
    this.detail = detail;
  }
}

/** 该节点没有对应的输出表（例如纯输出类节点）。 */
export class NodeOutputMissingError extends Error {
  code = 'NODE_OUTPUT_MISSING';
  constructor(nodeId: string) {
    super(`节点 ${nodeId} 没有可预览的输出表`);
    this.name = 'NodeOutputMissingError';
  }
}

export interface ReadNodePreviewOptions {
  /** 输出端口；为空或 'out' 表示主输出。 */
  handle?: string | null;
  /** 返回行数上限，缺省 PREVIEW_DEFAULT_LIMIT，最大 PREVIEW_MAX_LIMIT。 */
  limit?: number;
}

/** 读取指定运行中某节点输出表的前若干行。 */
export async function readNodePreview(
  runId: string,
  nodeId: string,
  opts: ReadNodePreviewOptions = {},
): Promise<PreviewResult> {
  const ctx = getRun(runId);
  if (!ctx) throw new RunExpiredError();

  const result = ctx.nodeResults.get(nodeId);
  if (!result || result.status !== 'success') {
    const status = result?.status ?? ctx.nodeStatus.get(nodeId) ?? 'pending';
    throw new NodeNotReadyError(result?.error ?? `当前状态：${status}`);
  }

  const table = tableNameForNode(nodeId, opts.handle);
  let columns;
  try {
    columns = await describeTable(ctx.session.connection, table);
  } catch {
    throw new NodeOutputMissingError(nodeId);
  }

  const rawLimit = Number(opts.limit ?? PREVIEW_DEFAULT_LIMIT);
  const limit = Math.min(
    Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : PREVIEW_DEFAULT_LIMIT),
    PREVIEW_MAX_LIMIT,
  );

  const reader = await ctx.session.connection.runAndReadAll(
    `SELECT * FROM ${quoteIdent(table)} LIMIT ${limit + 1}`,
  );
  const all = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
  const truncated = all.length > limit;
  const rows = (truncated ? all.slice(0, limit) : all).map((row) => toJsonSafeRow(row));

  return {
    nodeId,
    columns,
    rows,
    totalRows: result.rowCount,
    truncated,
  };
}
