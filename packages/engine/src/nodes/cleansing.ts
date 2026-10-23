import type { CleansingConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

const STRING_TYPE = /CHAR|TEXT|STRING/i;
const NUMBER_TYPE = /INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL/i;

/** 按 Alteryx 数据清理的顺序处理单个字符串表达式：替换 null → 去字符 → 改大小写。 */
function cleanseString(expr: string, cfg: CleansingConfig): string {
  let out = expr;
  if (cfg.replaceNullString) out = `COALESCE(${out}, '')`;
  if (cfg.trimWhitespace) out = `regexp_replace(${out}, '^\\s+|\\s+$', '', 'g')`;
  if (cfg.reduceWhitespace) out = `regexp_replace(${out}, '\\s+', ' ', 'g')`;
  if (cfg.removeAllWhitespace) out = `regexp_replace(${out}, '\\s+', '', 'g')`;
  if (cfg.removeLetters) out = `regexp_replace(${out}, '\\p{L}', '', 'g')`;
  if (cfg.removeNumbers) out = `regexp_replace(${out}, '[0-9]', '', 'g')`;
  if (cfg.removePunctuation) out = `regexp_replace(${out}, '[[:punct:]]', '', 'g')`;
  if (cfg.caseMode === 'upper') out = `upper(${out})`;
  else if (cfg.caseMode === 'lower') out = `lower(${out})`;
  else if (cfg.caseMode === 'title') out = `title(${out})`;
  return out;
}

/**
 * Data Cleansing：替换 null、去除不需要的字符、修改大小写，可移除全空行 / 空列。
 * 选项与语义对齐 Alteryx 的「数据清理」工具。
 */
export const cleansing: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Data Cleansing 节点缺少输入数据');

  const cfg = (ctx.node.config ?? {}) as unknown as CleansingConfig;
  const columns = await describeTable(ctx.connection, inputTable);
  if (columns.length === 0) throw new Error('Data Cleansing 节点没有可用字段');

  const configured = (cfg.fields ?? []).filter((field) => field && field.length > 0);
  const known = new Set(columns.map((col) => col.name));
  const selected = configured.length > 0
    ? configured.filter((field) => known.has(field))
    : columns.map((col) => col.name);
  if (configured.length > 0 && selected.length === 0) {
    throw new Error('Data Cleansing 选择的字段在上游数据中都不存在');
  }
  const selectedSet = new Set(selected);

  const stage = `__cleansing_${String(ctx.node.id).replace(/[^a-zA-Z0-9_]/g, '_')}`;

  const expressions = columns.map((col) => {
    const ident = quoteIdent(col.name);
    let expr = ident;
    const isString = STRING_TYPE.test(col.type);
    const isNumber = NUMBER_TYPE.test(col.type);
    if (selectedSet.has(col.name)) {
      if (isString) {
        expr = cleanseString(expr, cfg);
      } else if (isNumber) {
        if (cfg.replaceNullNumber) expr = `COALESCE(${expr}, 0)`;
      }
    }
    return `${expr} AS ${ident}`;
  });

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(stage)} AS
     SELECT ${expressions.join(', ')} FROM ${quoteIdent(inputTable)}`,
  );

  try {
    let keep = columns.map((col) => col.name);

    /* 移除 null 列：先统计每列的非空数，再按 any / all 语义决定丢弃哪些列。 */
    if (cfg.removeNullColumns) {
      const counts = columns
        .map((col, index) => `COUNT(${quoteIdent(col.name)}) AS __c${index}`)
        .join(', ');
      const reader = await ctx.connection.runAndReadAll(
        `SELECT COUNT(*) AS __total, ${counts} FROM ${quoteIdent(stage)}`,
      );
      const stats = (reader.getRowObjectsJS() as Array<Record<string, unknown>>)[0] ?? {};
      const total = Number(stats.__total ?? 0);
      const dropped: string[] = [];
      if (total > 0) {
        columns.forEach((col, index) => {
          const nonNull = Number(stats[`__c${index}`] ?? 0);
          const isNull = cfg.nullColumnMode === 'all' ? nonNull === 0 : nonNull < total;
          if (isNull) dropped.push(col.name);
        });
      }
      if (dropped.length > 0) {
        keep = keep.filter((name) => !dropped.includes(name));
        ctx.log('info', `移除空列 ${dropped.length} 个：${dropped.join('、')}`);
      }
      if (keep.length === 0) throw new Error('移除空列后没有剩余字段');
    }

    const projection = keep.map((name) => quoteIdent(name)).join(', ');
    const pending = keep
      .map((name) => `${quoteIdent(name)} IS NULL`)
      .join(cfg.nullRowMode === 'all' ? ' AND ' : ' OR ');
    const where = cfg.removeNullRows ? ` WHERE NOT (${pending})` : '';

    await ctx.connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
       SELECT ${projection} FROM ${quoteIdent(stage)}${where}`,
    );
  } finally {
    await ctx.connection.run(`DROP TABLE IF EXISTS ${quoteIdent(stage)}`).catch(() => undefined);
  }

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Data Cleansing 完成：${rowCount} 行`);
  return { rowCount };
};
