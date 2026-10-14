import type { SelectConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

export const select: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Select 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as SelectConfig;
  const configured = cfg?.fields ?? [];

  let selectList: string;
  if (configured.length === 0) {
    selectList = '*';
  } else {
    const included = configured
      .filter((f) => f && f.include !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (included.length === 0) throw new Error('Select 节点未选择任何字段');
    selectList = included
      .map((f) => {
        const alias = f.alias && f.alias.length > 0 ? f.alias : f.source;
        return `${quoteIdent(f.source)} AS ${quoteIdent(alias)}`;
      })
      .join(', ');
  }

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT ${selectList} FROM ${quoteIdent(inputTable)}`,
  );
  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Select 完成：${rowCount} 行`);
  return { rowCount };
};
