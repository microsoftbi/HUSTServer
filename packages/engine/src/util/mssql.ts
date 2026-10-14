import type { SqlServerConnection } from '../types.js';

/** 把节点配置里的连接信息转换为 mssql 所需的 config 对象。 */
export function buildMssqlConfig(conn: SqlServerConnection) {
  return {
    server: conn.server,
    port: conn.port ?? 1433,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    options: {
      encrypt: conn.encrypt ?? true,
      trustServerCertificate: conn.trustServerCertificate ?? true,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 0,
  };
}

/** 把 DuckDB 列类型映射为 SQL Server 列类型。 */
export function duckTypeToSqlServer(type: string): string {
  const t = type.toUpperCase();
  if (t.startsWith('DECIMAL') || t.startsWith('NUMERIC')) {
    const inner = t.slice(t.indexOf('(') + 1, t.indexOf(')'));
    return /^\d+\s*,\s*\d+$/.test(inner) ? `DECIMAL(${inner.replace(/\s/g, '')})` : 'DECIMAL(18,4)';
  }
  if (t.startsWith('VARCHAR') || t.startsWith('CHAR')) return 'NVARCHAR(MAX)';
  if (t.startsWith('BIGINT')) return 'BIGINT';
  if (t.startsWith('HUGEINT')) return 'DECIMAL(38,0)';
  if (t.startsWith('INTEGER') || t === 'INT' || t.startsWith('INT4')) return 'INT';
  if (t.startsWith('SMALLINT')) return 'SMALLINT';
  if (t.startsWith('TINYINT')) return 'TINYINT';
  if (t.startsWith('UBIGINT')) return 'DECIMAL(20,0)';
  if (t.startsWith('DOUBLE') || t.startsWith('FLOAT8')) return 'FLOAT';
  if (t.startsWith('REAL') || t.startsWith('FLOAT4') || t.startsWith('FLOAT')) return 'REAL';
  if (t.startsWith('BOOLEAN') || t.startsWith('BOOL')) return 'BIT';
  if (t.startsWith('TIMESTAMP') || t.startsWith('DATETIME')) return 'DATETIME2';
  if (t.startsWith('DATE')) return 'DATE';
  if (t.startsWith('TIME')) return 'TIME';
  if (t.startsWith('BLOB') || t.startsWith('BINARY') || t.startsWith('VARBINARY')) return 'VARBINARY(MAX)';
  if (t.startsWith('UUID')) return 'UNIQUEIDENTIFIER';
  return 'NVARCHAR(MAX)';
}
