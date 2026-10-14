import sql from 'mssql';
import type { InputSqlServerConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { materializeRows } from '../engine/ingest.js';
import { buildMssqlConfig } from '../util/mssql.js';

export const inputSqlServer: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as InputSqlServerConfig;
  if (!cfg?.connection) throw new Error('SQLServer 输入节点缺少连接信息');
  if (!cfg?.query || !cfg.query.trim()) throw new Error('SQLServer 输入节点缺少查询语句');

  const pool = await new sql.ConnectionPool(buildMssqlConfig(cfg.connection)).connect();
  try {
    const result = await pool.request().query(cfg.query);
    const rows = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const columns =
      rows.length > 0
        ? Object.keys(rows[0])
        : result.recordset && result.recordset.columns
          ? Object.keys(result.recordset.columns)
          : [];

    const rowCount = await materializeRows(ctx.connection, ctx.outputTable, rows, columns);
    ctx.log('success', `已从 SQLServer 读取：${rowCount} 行`);
    return { rowCount };
  } finally {
    await pool.close().catch(() => undefined);
  }
};
