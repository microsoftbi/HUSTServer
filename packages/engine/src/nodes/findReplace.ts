import type { FindReplaceConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/**
 * Find Replace：用查找表（R 输入）的值替换数据表（F 输入）中的字段值
 * （对齐 Alteryx 的 Find Replace）。重复的查找值取第一条匹配的替换值。
 */
export const findReplace: NodeExecutor = async (ctx) => {
  const dataTable = ctx.inputs['in'] ?? ctx.inputList[0];
  const lookupTable = ctx.inputs['lookup'] ?? ctx.inputList[1];
  if (!dataTable) throw new Error('Find Replace 节点缺少数据输入（F 输入）');
  if (!lookupTable) throw new Error('Find Replace 节点缺少查找表输入（R 输入）');

  const cfg = (ctx.node.config ?? {}) as unknown as FindReplaceConfig;
  const field = String(cfg.field ?? '').trim();
  if (!field) throw new Error('Find Replace 节点需要选择要查找的字段');

  const columns = await describeTable(ctx.connection, dataTable);
  if (!columns.some((col) => col.name === field)) {
    throw new Error(`Find Replace 字段不存在：${field}`);
  }

  const lookupColumns = await describeTable(ctx.connection, lookupTable);
  if (lookupColumns.length === 0) throw new Error('Find Replace 查找表没有可用字段');

  const findField = pickField(cfg.findField, lookupColumns, ['Find', '查找'], lookupColumns[0].name);
  const replaceField = pickField(
    cfg.replaceField,
    lookupColumns,
    ['Replace', '替换'],
    lookupColumns[1]?.name ?? lookupColumns[0].name,
  );

  const mode = cfg.mode === 'append' ? 'append' : 'replace';
  const newField =
    mode === 'append' ? String(cfg.newField ?? '').trim() || `${field}_Replaced` : '';
  if (mode === 'append' && columns.some((col) => col.name === newField)) {
    throw new Error(`Find Replace 新增字段与现有列重名：${newField}`);
  }

  const matchCase = cfg.matchCase !== false;
  const lookupKey = `CAST(${quoteIdent(findField)} AS VARCHAR)`;
  const dataKey = `CAST(d.${quoteIdent(field)} AS VARCHAR)`;
  const on = matchCase ? `${dataKey} = lk.f` : `lower(${dataKey}) = lower(lk.f)`;

  const projections = columns.map((col) =>
    col.name === field && mode === 'replace'
      ? `CASE WHEN lk.f IS NOT NULL THEN lk.r ELSE ${quoteIdent(field)} END AS ${quoteIdent(field)}`
      : quoteIdent(col.name),
  );
  if (mode === 'append') {
    projections.push(
      `CASE WHEN lk.f IS NOT NULL THEN lk.r ELSE ${quoteIdent(field)} END AS ${quoteIdent(newField)}`,
    );
  }

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     WITH lk AS (
       SELECT ${lookupKey} AS f, any_value(${quoteIdent(replaceField)}) AS r
       FROM ${quoteIdent(lookupTable)}
       GROUP BY 1
     )
     SELECT ${projections.join(', ')}
     FROM ${quoteIdent(dataTable)} d
     LEFT JOIN lk ON ${on}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log(
    'success',
    `Find Replace 完成：${mode === 'append' ? `新增字段 ${newField}` : `替换字段 ${field}`}，${rowCount} 行`,
  );
  return { rowCount };
};

/** 选取查找/替换字段：优先配置，其次按常见名称，最后按位置兜底。 */
function pickField(
  configured: unknown,
  columns: Array<{ name: string }>,
  preferred: string[],
  fallback: string,
): string {
  const name = String(configured ?? '').trim();
  if (name && columns.some((col) => col.name === name)) return name;
  for (const candidate of preferred) {
    const hit = columns.find((col) => col.name.toLowerCase() === candidate.toLowerCase());
    if (hit) return hit.name;
  }
  return fallback;
}
