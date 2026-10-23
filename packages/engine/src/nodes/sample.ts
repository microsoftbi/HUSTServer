import type { SampleConfig, SampleMode } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

const MODE_LABEL: Record<SampleMode, string> = {
  first: '前 N 行',
  last: '后 N 行',
  skip: '跳过前 N 行',
  every: '每 N 行中的第一行',
  random: '每行有 N 分之一的机会',
  percent: '前百分之 N 行',
};

/** Sample：按 Alteryx 的六种抽样方式取数，可选按列分组后每组各取 N 行。 */
export const sample: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Sample 节点缺少输入数据');

  const cfg = ctx.node.config as unknown as SampleConfig;
  const mode: SampleMode = cfg?.mode ?? 'first';
  const n = Number(cfg?.n);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Sample 的 N 必须是大于 0 的数字');
  if (mode === 'percent' && n > 100) throw new Error('Sample 的百分比不能超过 100');
  if (mode === 'every' && Math.trunc(n) < 1) throw new Error('Sample 的 N 必须是正整数');

  const columns = await describeTable(ctx.connection, inputTable);
  const names = new Set(columns.map((col) => col.name));
  const groupBy = (cfg?.groupBy ?? []).filter((field) => field && field.length > 0);
  for (const field of groupBy) {
    if (!names.has(field)) throw new Error(`Sample 分组字段不存在：${field}`);
  }

  const projection = columns.map((col) => quoteIdent(col.name)).join(', ');
  const partition = groupBy.length > 0
    ? `PARTITION BY ${groupBy.map((field) => quoteIdent(field)).join(', ')}`
    : '';

  let condition: string;
  switch (mode) {
    case 'last':
      condition = `__sample_rn > __sample_cnt - ${Math.trunc(n)}`;
      break;
    case 'skip':
      condition = `__sample_rn > ${Math.trunc(n)}`;
      break;
    case 'every':
      condition = `((__sample_rn - 1) % ${Math.trunc(n)}) = 0`;
      break;
    case 'random':
      condition = `random() < ${1 / n}`;
      break;
    case 'percent':
      condition = `__sample_rn <= CEIL(__sample_cnt * ${n} / 100.0)`;
      break;
    case 'first':
    default:
      condition = `__sample_rn <= ${Math.trunc(n)}`;
      break;
  }

  const orderBy = groupBy.length > 0
    ? `${groupBy.map((field) => quoteIdent(field)).join(', ')}, __sample_rn`
    : '__sample_rn';

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     WITH __sample_base AS (
       SELECT *,
              ROW_NUMBER() OVER (${partition}) AS __sample_rn,
              COUNT(*) OVER (${partition}) AS __sample_cnt
       FROM ${quoteIdent(inputTable)}
     )
     SELECT ${projection} FROM __sample_base
     WHERE ${condition}
     ORDER BY ${orderBy}`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Sample 完成：${MODE_LABEL[mode]}，${rowCount} 行`);
  return { rowCount };
};
