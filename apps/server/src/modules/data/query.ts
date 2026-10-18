import sql from 'mssql';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';

export type QueryCell = string | number | boolean | null;

export interface QueryColumn {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'unknown';
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: QueryCell[][];
  truncated: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

/** 按列的首个非空值推断类型（mssql 已返回强类型值；字符串仅识别日期）。 */
function inferColumnType(values: unknown[]): QueryColumn['type'] {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (v instanceof Date) return 'date';
    if (typeof v === 'string') return Number.isNaN(Date.parse(v)) ? 'string' : 'date';
    return 'string';
  }
  return 'unknown';
}

function toCell(v: unknown): QueryCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

export async function runQuery(
  conn: SqlServerConnection,
  query: string,
  limit?: number,
  timeoutMs?: number,
): Promise<QueryResult> {
  const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cfg = buildMssqlConfig(conn);
  const pool = new sql.ConnectionPool(timeoutMs ? { ...cfg, requestTimeout: timeoutMs } : cfg);
  try {
    await pool.connect();
    const result = await pool.request().query(query);
    const recordset = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const names = Object.keys(result.recordset?.columns ?? recordset[0] ?? {});
    return {
      columns: names.map((name) => ({ name, type: inferColumnType(recordset.map((r) => r[name])) })),
      rows: recordset.slice(0, cap).map((r) => names.map((n) => toCell(r[n]))),
      truncated: recordset.length > cap,
    };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

/** 列出连接所在库中的表与视图（供仪表板选择数据表）。 */
export async function listTables(conn: SqlServerConnection): Promise<TableInfo[]> {
  const pool = new sql.ConnectionPool(buildMssqlConfig(conn));
  try {
    await pool.connect();
    const result = await pool.request().query(
      "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME",
    );
    const recordset = (result.recordset ?? []) as Array<Record<string, unknown>>;
    return recordset.map((r) => ({
      schema: String(r.TABLE_SCHEMA ?? ''),
      name: String(r.TABLE_NAME ?? ''),
      type: r.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
    }));
  } finally {
    await pool.close().catch(() => undefined);
  }
}
