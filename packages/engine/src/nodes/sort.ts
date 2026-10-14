import type { SortConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

export const sort: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Sort 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as SortConfig;
  const sorts = (cfg?.sorts ?? []).filter((s) => s && s.field);
  if (sorts.length === 0) throw new Error('Sort 节点缺少排序字段');

  const orderList = sorts
    .map((s) => {
      const direction = s.direction === 'desc' ? 'DESC' : 'ASC';
      const nulls = s.nulls ? ` NULLS ${s.nulls === 'first' ? 'FIRST' : 'LAST'}` : '';
      return `${quoteIdent(s.field)} ${direction}${nulls}`;
    })
    .join(', ');

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT * FROM ${quoteIdent(inputTable)} ORDER BY ${orderList}`,
  );
  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Sort 完成：${rowCount} 行`);
  return { rowCount };
};
