import type { RunningTotalConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

const NUMBER_TYPE = /INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL/i;

/**
 * Running Total：按数据流顺序累加数值字段，可按分组字段重启动累计。
 * 与 Alteryx 一致：不显式排序，累加顺序就是记录进入节点的顺序（需要固定顺序时先用 Sort）。
 */
export const runningTotal: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Running Total 节点缺少输入数据');

  const cfg = (ctx.node.config ?? {}) as unknown as RunningTotalConfig;
  const items = (cfg.items ?? []).filter((item) => item && item.field);
  if (items.length === 0) throw new Error('Running Total 节点至少需要一个累计字段');

  const columns = await describeTable(ctx.connection, inputTable);
  const types = new Map(columns.map((col) => [col.name, col.type]));
  const groupBy = (cfg.groupBy ?? []).filter((field) => field && field.length > 0);

  for (const item of items) {
    if (!types.has(item.field)) throw new Error(`Running Total 字段不存在：${item.field}`);
    if (!NUMBER_TYPE.test(types.get(item.field) ?? '')) {
      throw new Error(`Running Total 只支持数值字段：${item.field}`);
    }
  }
  for (const field of groupBy) {
    if (!types.has(field)) throw new Error(`Running Total 分组字段不存在：${field}`);
  }

  const partition = groupBy.length > 0
    ? `PARTITION BY ${groupBy.map((field) => quoteIdent(field)).join(', ')} `
    : '';
  const replaced = new Map(
    items.filter((item) => item.replaceExisting).map((item) => [item.field, item]),
  );

  const runningExpr = (field: string): string =>
    `SUM(CAST(${quoteIdent(field)} AS DOUBLE)) OVER (${partition}ORDER BY __rt_rn ` +
    `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;

  /* 覆盖原列：保持列位置不变；新增列：追加在末尾，命名与 Alteryx 的 RunningTotal_<字段> 对齐。 */
  const projections = columns.map((col) => {
    if (replaced.has(col.name)) return `${runningExpr(col.name)} AS ${quoteIdent(col.name)}`;
    return quoteIdent(col.name);
  });
  for (const item of items) {
    if (item.replaceExisting) continue;
    const name = item.outputName?.trim() || `RunningTotal_${item.field}`;
    projections.push(`${runningExpr(item.field)} AS ${quoteIdent(name)}`);
  }

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     WITH __rt_base AS (
       SELECT *, ROW_NUMBER() OVER () AS __rt_rn FROM ${quoteIdent(inputTable)}
     )
     SELECT ${projections.join(', ')} FROM __rt_base ORDER BY __rt_rn`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Running Total 完成：${items.length} 个字段，${rowCount} 行`);
  return { rowCount };
};
