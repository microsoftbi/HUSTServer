import { createConnection } from 'node:net';
import sql from 'mssql';
import { buildMssqlConfig, type SqlObjectRef, type SqlServerConnection } from '@hustserver/engine';

export function testTcp(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, '连接超时'));
    socket.once('error', (err) => finish(false, (err as Error).message));
  });
}

/**
 * 真实连接 SQL Server 并列出可用的用户数据库（排除 master/model/msdb/tempdb）。
 * 未指定数据库时先连到 master 再枚举。
 */
export async function listSqlServerDatabases(
  conn: SqlServerConnection,
): Promise<{ ok: boolean; databases?: string[]; error?: string }> {
  const pool = new sql.ConnectionPool(
    buildMssqlConfig({ ...conn, database: conn.database || 'master' }),
  );
  try {
    await pool.connect();
    const result = await pool
      .request()
      .query('SELECT name FROM sys.databases WHERE state = 0 AND database_id > 4 ORDER BY name');
    const databases = (result.recordset ?? []).map((r: { name: string }) => String(r.name));
    return { ok: true, databases };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

/**
 * 连接指定数据库并列出其中的用户表与视图（供画布中选择表）。
 * 使用当前连接自身的 database，不跨库枚举。
 */
export async function listSqlServerObjects(
  conn: SqlServerConnection,
): Promise<{ ok: boolean; objects?: SqlObjectRef[]; error?: string }> {
  const pool = new sql.ConnectionPool(buildMssqlConfig(conn));
  try {
    await pool.connect();
    const result = await pool.request().query(
      `SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name], TABLE_TYPE AS [type]
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    const objects: SqlObjectRef[] = (result.recordset ?? []).map(
      (r: { schema: string; name: string; type: string }) => ({
        schema: String(r.schema),
        name: String(r.name),
        type: r.type === 'VIEW' ? 'view' : 'table',
      }),
    );
    return { ok: true, objects };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await pool.close().catch(() => undefined);
  }
}
