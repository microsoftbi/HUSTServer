import os from 'node:os';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DUCKDB_MEMORY_LIMIT, SPILL_DIR, ensureDirs } from '../config.js';
import { quoteIdent } from '../util/sqlIdent.js';

export interface DuckSession {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}

/** 为单次运行创建独立的内存 DuckDB 实例，超出内存上限时自动 spill 到 SPILL_DIR。 */
export async function createSession(): Promise<DuckSession> {
  ensureDirs();
  const instance = await DuckDBInstance.create(':memory:', {
    temp_directory: SPILL_DIR,
    memory_limit: DUCKDB_MEMORY_LIMIT,
    threads: String(Math.max(2, Math.min(8, os.cpus().length))),
  });
  const connection = await instance.connect();
  return { instance, connection };
}

export function closeSession(session: DuckSession | null): void {
  if (!session) return;
  try {
    session.connection.closeSync();
  } catch {
    /* ignore */
  }
  try {
    session.instance.closeSync();
  } catch {
    /* ignore */
  }
}

export interface ColumnInfo {
  name: string;
  type: string;
}

/** 读取表的列名与类型。 */
export async function describeTable(
  connection: DuckDBConnection,
  table: string,
): Promise<ColumnInfo[]> {
  const reader = await connection.runAndReadAll(`DESCRIBE ${quoteIdent(table)}`);
  const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    name: String(r.column_name),
    type: String(r.column_type),
  }));
}

export async function countRows(connection: DuckDBConnection, table: string): Promise<number> {
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`,
  );
  const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
  return Number(rows[0]?.c ?? 0);
}

/** 执行一条不返回结果的语句。 */
export async function runSql(
  connection: DuckDBConnection,
  sql: string,
): Promise<void> {
  await connection.run(sql);
}
