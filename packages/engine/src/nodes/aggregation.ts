import type { AggregationConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

export const aggregation: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Aggregation 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as AggregationConfig;
  const groupBy = (cfg?.groupBy ?? []).filter((f) => f && f.length > 0);
  const aggregations = cfg?.aggregations ?? [];

  if (groupBy.length === 0 && aggregations.length === 0) {
    throw new Error('Aggregation 节点需要至少一个分组字段或聚合函数');
  }

  const groupList = groupBy.map((f) => quoteIdent(f));
  const selectParts = [...groupList];

  for (const item of aggregations) {
    const fn = item.fn;
    const field = item.field ?? '';
    const isCountAll = fn === 'count' && (field === '' || field === '*');
    const expr = isCountAll ? 'COUNT(*)' : `${fn.toUpperCase()}(${quoteIdent(field)})`;
    const defaultAlias = isCountAll ? 'count_all' : `${fn}_${field}`;
    const alias = item.alias && item.alias.length > 0 ? item.alias : defaultAlias;
    selectParts.push(`${expr} AS ${quoteIdent(alias)}`);
  }

  let sql: string;
  if (selectParts.length === 0) {
    throw new Error('Aggregation 节点配置无效');
  }

  if (aggregations.length === 0) {
    // 只有分组字段：等价于去重
    sql = `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
           SELECT DISTINCT ${groupList.join(', ')} FROM ${quoteIdent(inputTable)}`;
  } else {
    const groupClause = groupBy.length > 0 ? ` GROUP BY ${groupList.join(', ')}` : '';
    sql = `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
           SELECT ${selectParts.join(', ')} FROM ${quoteIdent(inputTable)}${groupClause}`;
  }

  await ctx.connection.run(sql);
  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Aggregation 完成：${rowCount} 行`);
  return { rowCount };
};
