import type { CrossTabConfig, CrossTabMethod } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/** 聚合方式 → DuckDB 聚合表达式；与 Alteryx 交叉表的取值方法一致。 */
function aggregate(method: CrossTabMethod): (expr: string) => string {
  switch (method) {
    case 'last':
      return (expr) => `last(${expr})`;
    case 'sum':
      return (expr) => `sum(${expr})`;
    case 'count':
      return (expr) => `count(${expr})`;
    case 'min':
      return (expr) => `min(${expr})`;
    case 'max':
      return (expr) => `max(${expr})`;
    case 'concat':
      return (expr) => `string_agg(CAST(${expr} AS VARCHAR), ', ')`;
    case 'first':
    default:
      return (expr) => `first(${expr})`;
  }
}

/**
 * Cross Tab：把「表头字段」的取值转成列，把「数值字段」的取值填入单元格。
 * 与 Alteryx 一致：可选分组字段（为空则汇成一行），同一单元格有多个值时按聚合方式合并。
 */
export const crossTab: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Cross Tab 节点缺少输入数据');

  const cfg = (ctx.node.config ?? {}) as unknown as CrossTabConfig;
  const headerField = cfg.headerField?.trim();
  const valueField = cfg.valueField?.trim();
  if (!headerField) throw new Error('Cross Tab 节点需要选择表头字段');
  if (!valueField) throw new Error('Cross Tab 节点需要选择值字段');

  const columns = await describeTable(ctx.connection, inputTable);
  const names = new Set(columns.map((col) => col.name));
  for (const field of [headerField, valueField]) {
    if (!names.has(field)) throw new Error(`Cross Tab 字段不存在：${field}`);
  }
  const groupBy = (cfg.groupBy ?? []).filter((field) => field && field.length > 0);
  for (const field of groupBy) {
    if (!names.has(field)) throw new Error(`Cross Tab 分组字段不存在：${field}`);
  }

  const reader = await ctx.connection.runAndReadAll(
    `SELECT DISTINCT CAST(${quoteIdent(headerField)} AS VARCHAR) AS k
     FROM ${quoteIdent(inputTable)}
     WHERE ${quoteIdent(headerField)} IS NOT NULL
     ORDER BY 1`,
  );
  const headers = (reader.getRowObjectsJS() as Array<Record<string, unknown>>)
    .map((row) => String(row.k ?? ''))
    .filter((value) => value.length > 0);

  const groupProjection = groupBy.map((field) => quoteIdent(field));
  if (headers.length === 0) {
    await ctx.connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
       SELECT ${groupProjection.length > 0 ? groupProjection.join(', ') : '1 AS __empty'}
       FROM ${quoteIdent(inputTable)} WHERE FALSE`,
    );
    ctx.log('warn', 'Cross Tab 未找到可用的表头值，输出为空表');
    return { rowCount: 0 };
  }

  const prefix = cfg.prefix ?? '';
  const method = aggregate(cfg.method ?? 'first');
  const cells = headers.map((header) => {
    const alias = `${prefix}${header}`;
    if (names.has(alias) && !groupBy.includes(alias)) {
      throw new Error(`Cross Tab 生成的列与现有列重名：${alias}`);
    }
    const conditional =
      `CASE WHEN CAST(${quoteIdent(headerField)} AS VARCHAR) = '${header.replace(/'/g, "''")}' ` +
      `THEN ${quoteIdent(valueField)} END`;
    return `${method(conditional)} AS ${quoteIdent(alias)}`;
  });

  const groupClause = groupBy.length > 0 ? ` GROUP BY ${groupProjection.join(', ')}` : '';
  const orderClause = groupBy.length > 0 ? ` ORDER BY ${groupProjection.join(', ')}` : '';
  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT ${[...groupProjection, ...cells].join(', ')}
     FROM ${quoteIdent(inputTable)}${groupClause}${orderClause}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Cross Tab 完成：${headers.length} 个表头值转为列，${rowCount} 行`);
  return { rowCount };
};
