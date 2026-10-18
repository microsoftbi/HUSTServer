import sql from 'mssql';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';

export interface ExploreColumn {
  name: string;
  type: string;
}

/** 探索查询的语句超时（毫秒），避免慢查询长期占用连接。 */
export const EXPLORE_TIMEOUT_MS = 30_000;

/** 读取连接库中某张表/视图的列（列名 + 数据库原始类型名）。 */
export async function listColumns(
  conn: SqlServerConnection,
  schema: string,
  table: string,
): Promise<ExploreColumn[]> {
  const pool = new sql.ConnectionPool({ ...buildMssqlConfig(conn), requestTimeout: EXPLORE_TIMEOUT_MS });
  try {
    await pool.connect();
    const result = await pool
      .request()
      .input('schema', sql.NVarChar, schema)
      .input('table', sql.NVarChar, table)
      .query(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
          ORDER BY ORDINAL_POSITION`,
      );
    const recordset = (result.recordset ?? []) as Array<{ name: unknown; type: unknown }>;
    return recordset.map((r) => ({ name: String(r.name ?? ''), type: String(r.type ?? '') }));
  } finally {
    await pool.close().catch(() => undefined);
  }
}
