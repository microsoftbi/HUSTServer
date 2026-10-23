import type { UniqueConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/**
 * Unique：按选定字段分组，U 输出每组首行、D 输出每组其余行（对齐 Alteryx 的 U / D 双锚点）。
 * 输出按唯一值字段排序，与 Alteryx 的排序行为一致。
 */
export const unique: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Unique 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as UniqueConfig;
  const fields = (cfg?.fields ?? []).filter((field) => field && field.length > 0);
  if (fields.length === 0) throw new Error('Unique 节点至少需要一个用于判断唯一值的字段');

  const columns = await describeTable(ctx.connection, inputTable);
  const names = new Set(columns.map((col) => col.name));
  for (const field of fields) {
    if (!names.has(field)) throw new Error(`Unique 字段不存在：${field}`);
  }

  const keys = fields.map((field) => quoteIdent(field)).join(', ');
  const projection = columns.map((col) => quoteIdent(col.name)).join(', ');
  const ranked = `WITH __unique_ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keys} ORDER BY ${keys}) AS __unique_rn
      FROM ${quoteIdent(inputTable)}
    )`;

  const dupTable = ctx.outputTableFor('d');
  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     ${ranked}
     SELECT ${projection} FROM __unique_ranked WHERE __unique_rn = 1 ORDER BY ${keys}`,
  );
  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(dupTable)} AS
     ${ranked}
     SELECT ${projection} FROM __unique_ranked WHERE __unique_rn > 1 ORDER BY ${keys}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  const dupCount = await countRows(ctx.connection, dupTable);
  ctx.log('success', `Unique 完成：唯一 ${rowCount} 行，重复 ${dupCount} 行`);
  return { rowCount };
};
