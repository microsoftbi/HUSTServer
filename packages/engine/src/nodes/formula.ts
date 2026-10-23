import type { FormulaConfig, FormulaDataType } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/** Formula 数据类型 → DuckDB 类型；字符串按 Alteryx 的 Size 声明宽度。 */
function castType(dataType: FormulaDataType, size?: number): string {
  if (dataType === 'VARCHAR' && size && size > 0) return `VARCHAR(${Math.trunc(size)})`;
  return dataType;
}

/**
 * Formula：按配置顺序逐条计算表达式，可覆盖现有列或追加新列。
 * 后面的表达式能引用前面新建的列（用 CTE 链保证求值顺序）。
 */
export const formula: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Formula 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as FormulaConfig;
  const formulas = cfg?.formulas ?? [];
  if (formulas.length === 0) throw new Error('Formula 节点至少需要一个表达式');

  formulas.forEach((item, index) => {
    if (!item?.field?.trim()) throw new Error(`Formula 第 ${index + 1} 个表达式缺少输出列名`);
    if (!item?.expression?.trim()) throw new Error(`Formula 第 ${index + 1} 个表达式缺少内容`);
  });

  const columns = await describeTable(ctx.connection, inputTable);
  const known = new Set(columns.map((col) => col.name));

  const ctes: string[] = [];
  let source = quoteIdent(inputTable);

  formulas.forEach((item, index) => {
    const alias = item.field.trim();
    const expression = `CAST((${item.expression}) AS ${castType(item.dataType, item.size)})`;
    // 同名即覆盖（REPLACE），否则在末尾追加新列。
    const projection = known.has(alias)
      ? `SELECT * REPLACE (${expression} AS ${quoteIdent(alias)}) FROM ${source}`
      : `SELECT *, ${expression} AS ${quoteIdent(alias)} FROM ${source}`;
    const cte = `__formula_${index}`;
    ctes.push(`${quoteIdent(cte)} AS (${projection})`);
    source = quoteIdent(cte);
    known.add(alias);
  });

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     WITH ${ctes.join(', ')}
     SELECT * FROM ${source}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Formula 完成：${formulas.length} 个表达式，${rowCount} 行`);
  return { rowCount };
};
