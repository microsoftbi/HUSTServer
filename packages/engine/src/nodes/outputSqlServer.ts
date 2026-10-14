import sql from 'mssql';
import type { OutputSqlServerConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { describeTable } from '../engine/duckdb.js';
import { buildMssqlConfig, duckTypeToSqlServer } from '../util/mssql.js';
import { isValidSqlObjectName } from '../util/sqlIdent.js';
import { quoteIdent } from '../util/sqlIdent.js';

function bracketRef(name: string): string {
  return name
    .split('.')
    .map((part) => `[${part.replace(/]/g, ']]')}]`)
    .join('.');
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    return value >= -9223372036854775808n && value <= 9223372036854775807n
      ? value
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

export const outputSqlServer: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('SQLServer 输出节点缺少输入数据');

  const cfg = ctx.node.config as unknown as OutputSqlServerConfig;
  if (!cfg?.connection) throw new Error('SQLServer 输出节点缺少连接信息');
  if (!cfg?.table) throw new Error('SQLServer 输出节点缺少目标表名');
  if (!isValidSqlObjectName(cfg.table)) {
    throw new Error(`非法表名：${cfg.table}（仅允许字母、数字、下划线与单层 schema.table）`);
  }

  const columns = await describeTable(ctx.connection, inputTable);
  const reader = await ctx.connection.runAndReadAll(`SELECT * FROM ${quoteIdent(inputTable)}`);
  const rawRows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
  const rows = rawRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalizeCell(value);
    return out;
  });

  const pool = await new sql.ConnectionPool(buildMssqlConfig(cfg.connection)).connect();
  try {
    const ref = bracketRef(cfg.table);

    if (cfg.mode === 'overwrite') {
      await pool.request().query(`IF OBJECT_ID(N'${cfg.table}', N'U') IS NOT NULL DROP TABLE ${ref}`);
    }

    const shouldCreate = cfg.createTable !== false || cfg.mode === 'overwrite';
    if (shouldCreate) {
      const defs = columns
        .map((c) => `${bracketRef(c.name)} ${duckTypeToSqlServer(c.type)}`)
        .join(', ');
      await pool.request().query(`IF OBJECT_ID(N'${cfg.table}', N'U') IS NULL CREATE TABLE ${ref} (${defs})`);
    }

    if (rows.length > 0) {
      // mssql 运行时支持 bulk(表名字符串, 行数组)，但 @types/mssql 未声明该重载。
      const request = pool.request() as unknown as {
        bulk: (table: string, rows: Array<Record<string, unknown>>) => Promise<unknown>;
      };
      await request.bulk(cfg.table, rows);
    }

    await ctx.connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS SELECT * FROM ${quoteIdent(inputTable)}`,
    );
    ctx.log('success', `已写出 SQLServer：${rows.length} 行 → ${cfg.table}`);
    return { rowCount: rows.length, note: cfg.table };
  } finally {
    await pool.close().catch(() => undefined);
  }
};
