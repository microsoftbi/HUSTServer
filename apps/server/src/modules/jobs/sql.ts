import sql from 'mssql';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';

export interface SqlExecResult {
  rowsAffected: number;
  rowCount: number;
}

export type SqlExecutor = (connConfig: SqlServerConnection, sqlText: string) => Promise<SqlExecResult>;

/** 默认执行器：mssql 直连；无论成败都在 finally 关闭连接池。 */
export const defaultSqlExecutor: SqlExecutor = async (connConfig, sqlText) => {
  const pool = new sql.ConnectionPool(buildMssqlConfig(connConfig));
  await pool.connect();
  try {
    const result = await pool.request().query(sqlText);
    return {
      rowsAffected: result.rowsAffected.reduce((sum, n) => sum + n, 0),
      rowCount: result.recordset?.length ?? 0,
    };
  } finally {
    await pool.close();
  }
};
