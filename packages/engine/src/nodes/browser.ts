import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/** Browser 节点：仅接收上游数据并物化为缓存表，供运行后查看全部数据。无输出钩子。 */
export const browser: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Browser 节点缺少输入数据');

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS SELECT * FROM ${quoteIdent(inputTable)}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Browser 已缓存 ${rowCount} 行`);
  return { rowCount };
};
