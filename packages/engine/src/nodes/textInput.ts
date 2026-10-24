import type { TextInputConfig, TextInputField, TextInputFieldType } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';

/** 字段类型对应的 DuckDB 强制执行类型。 */
const FIELD_TYPES: TextInputFieldType[] = [
  'VARCHAR',
  'BIGINT',
  'DOUBLE',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
];

/**
 * Text Input：手工录入常量数据，作为码表或参数表使用（对齐 Alteryx 的 Text Input）。
 * 单元格按字段类型显式转换；空单元格在非字符串字段上生成 NULL。
 */
export const textInput: NodeExecutor = async (ctx) => {
  const cfg = (ctx.node.config ?? {}) as unknown as TextInputConfig;
  const fields = (cfg.fields ?? []).filter((item): item is TextInputField =>
    Boolean(item && String(item.name ?? '').trim()),
  );
  if (fields.length === 0) throw new Error('Text Input 节点至少需要一个字段');

  const columns = fields.map((field) => quoteIdent(field.name.trim()));
  const rows = (cfg.rows ?? []).filter((row) => Array.isArray(row));

  if (rows.length === 0) {
    // 无数据行时仍输出带类型的空表，便于下游字段选择
    const empty = fields
      .map((field) => `CAST(NULL AS ${typeOf(field)}) AS ${quoteIdent(field.name.trim())}`)
      .join(', ');
    await ctx.connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
       SELECT ${empty} FROM (SELECT 1) WHERE FALSE`,
    );
    ctx.log('success', 'Text Input 完成：无数据行，仅输出字段结构');
    return { rowCount: 0 };
  }

  const values = rows
    .map((row) => `(${fields.map((field, index) => cellSql(row[index], field)).join(', ')})`)
    .join(', ');

  const projections = fields
    .map((field) => {
      const name = quoteIdent(field.name.trim());
      return `CAST(${name} AS ${typeOf(field)}) AS ${name}`;
    })
    .join(', ');

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT ${projections}
     FROM (VALUES ${values}) AS t(${columns.join(', ')})`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Text Input 完成：${fields.length} 个字段，${rowCount} 行`);
  return { rowCount };
};

function typeOf(field: TextInputField): TextInputFieldType {
  return FIELD_TYPES.includes(field.type) ? field.type : 'VARCHAR';
}

/** 单元格字面量：空值在非字符串字段上转为 NULL，其余显式转字符串。 */
function cellSql(raw: unknown, field: TextInputField): string {
  const value = raw === null || raw === undefined ? '' : String(raw);
  const type = typeOf(field);
  if (type !== 'VARCHAR' && value.trim() === '') return 'NULL';
  return quoteString(value);
}
