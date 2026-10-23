import type { TextToColumnsConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/**
 * Text to Columns：按分隔符把单个字段拆成多列或多行。
 * 与 Alteryx 一致：原字段被替换；拆分为列时新列名为 <根名称>1、<根名称>2…；
 * 拆分为行时其余字段按行重复。
 */
export const textToColumns: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Text to Columns 节点缺少输入数据');

  const cfg = (ctx.node.config ?? {}) as unknown as TextToColumnsConfig;
  const field = cfg.field?.trim();
  const delimiter = cfg.delimiter ?? ',';
  if (!field) throw new Error('Text to Columns 节点需要选择要拆分的字段');
  if (delimiter.length === 0) throw new Error('Text to Columns 节点需要指定分隔符');

  const columns = await describeTable(ctx.connection, inputTable);
  if (!columns.some((col) => col.name === field)) {
    throw new Error(`Text to Columns 字段不存在：${field}`);
  }

  const root = cfg.rootName?.trim() || field;
  const skipEmpty = cfg.skipEmpty === true;
  const parts = skipEmpty
    ? `list_filter(string_split(${quoteIdent(field)}, ${sqlLiteral(delimiter)}), x -> x IS NOT NULL AND x <> '')`
    : `string_split(${quoteIdent(field)}, ${sqlLiteral(delimiter)})`;

  if (cfg.mode === 'rows') {
    const projections = columns.map((col) =>
      col.name === field
        ? `unnest(${parts}) AS ${quoteIdent(field)}`
        : quoteIdent(col.name),
    );
    await ctx.connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
       SELECT ${projections.join(', ')} FROM ${quoteIdent(inputTable)}`,
    );
    const rowCount = await countRows(ctx.connection, ctx.outputTable);
    ctx.log('success', `Text to Columns 完成：拆分为行，${rowCount} 行`);
    return { rowCount };
  }

  /* 拆分为列：先扫描最大分段数，再按需要的列数逐个取值（缺失分段为 null）。 */
  const reader = await ctx.connection.runAndReadAll(
    `SELECT MAX(len(${parts})) AS n FROM ${quoteIdent(inputTable)}`,
  );
  const scanned = Number((reader.getRowObjectsJS() as Array<Record<string, unknown>>)[0]?.n ?? 0);
  const requested = Math.trunc(Number(cfg.maxColumns ?? 0));
  const count = requested > 0 ? requested : Math.max(1, scanned);

  const existing = new Set(columns.map((col) => col.name));
  const created: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const name = `${root}${index}`;
    if (existing.has(name)) throw new Error(`Text to Columns 生成的新列与现有列重名：${name}`);
    created.push(name);
  }

  const inserted = created
    .map((name, index) => `list_extract(${parts}, ${index + 1}) AS ${quoteIdent(name)}`)
    .join(', ');
  const projections = columns.map((col) =>
    col.name === field ? inserted : quoteIdent(col.name),
  );

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT ${projections.join(', ')} FROM ${quoteIdent(inputTable)}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Text to Columns 完成：拆分为 ${count} 列，${rowCount} 行`);
  return { rowCount };
};

/** DuckDB 字符串字面量：单引号转义。 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
