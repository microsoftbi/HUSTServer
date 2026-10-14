import type { FilterConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

export const filter: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Filter 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as FilterConfig;
  const expression = (cfg?.expression ?? '').trim();
  if (!expression) throw new Error('Filter 节点缺少过滤表达式');

  const fTable = ctx.outputTableFor('f');

  // T 输出：命中条件的行；F 输出：其余行（含表达式结果为 NULL 的行）。
  // 用 IS NOT TRUE 保证 T ∪ F = 全部行且互斥。
  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT * FROM ${quoteIdent(inputTable)} WHERE (${expression})`,
  );
  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(fTable)} AS
     SELECT * FROM ${quoteIdent(inputTable)} WHERE (${expression}) IS NOT TRUE`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  const fCount = await countRows(ctx.connection, fTable);
  ctx.log('success', `Filter 完成：T ${rowCount} 行，F ${fCount} 行`);
  return { rowCount };
};
