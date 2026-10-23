import type { TransposeConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/**
 * Transpose：把选定的数据列转成行，输出「键字段 + Name + Value」。
 * 与 Alteryx 一致：Name 存放原列名，Value 存放取值；所有数据列类型不一致时统一转成字符串。
 */
export const transpose: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Transpose 节点缺少输入数据');

  const cfg = (ctx.node.config ?? {}) as unknown as TransposeConfig;
  const keyFields = (cfg.keyFields ?? []).filter((field) => field && field.length > 0);
  const dataFields = (cfg.dataFields ?? []).filter((field) => field && field.length > 0);
  if (dataFields.length === 0) throw new Error('Transpose 节点至少需要一个数据字段');

  const columns = await describeTable(ctx.connection, inputTable);
  const types = new Map(columns.map((col) => [col.name, col.type]));
  for (const field of [...keyFields, ...dataFields]) {
    if (!types.has(field)) throw new Error(`Transpose 字段不存在：${field}`);
  }
  for (const reserved of ['Name', 'Value']) {
    if (keyFields.includes(reserved)) {
      throw new Error(`Transpose 的键字段不能命名为 ${reserved}（与输出列冲突）`);
    }
  }

  /* 类型一致则保留原类型，否则统一为字符串（与 Alteryx 混类型时的行为一致）。 */
  const distinctTypes = new Set(dataFields.map((field) => types.get(field) ?? 'VARCHAR'));
  const valueType = distinctTypes.size === 1 ? [...distinctTypes][0] : 'VARCHAR';

  const keyProjection = keyFields.map((field) => quoteIdent(field));
  const selects = dataFields.map(
    (field) =>
      `SELECT ${[...keyProjection, `'${field.replace(/'/g, "''")}' AS "Name"`,
        `CAST(${quoteIdent(field)} AS ${valueType}) AS "Value"`].join(', ')}
       FROM ${quoteIdent(inputTable)}`,
  );

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     ${selects.join(' UNION ALL ')}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Transpose 完成：${dataFields.length} 个字段转为行，${rowCount} 行`);
  return { rowCount };
};
