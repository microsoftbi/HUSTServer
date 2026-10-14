import fs from 'node:fs';
import type { OutputCsvConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { normalizeDelimiter } from '../util/format.js';
import { resolveOutputPath } from '../util/io.js';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';

export const outputCsv: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('CSV 输出节点缺少输入数据');

  const cfg = ctx.node.config as unknown as OutputCsvConfig;
  if (!cfg?.path) throw new Error('CSV 输出节点缺少输出路径');

  const fullPath = resolveOutputPath(cfg.path);
  const delimiter = normalizeDelimiter(cfg.delimiter);
  const hasHeader = cfg.hasHeader !== false;

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS SELECT * FROM ${quoteIdent(inputTable)}`,
  );
  await ctx.connection.run(
    `COPY ${quoteIdent(ctx.outputTable)} TO ${quoteString(fullPath)}
     (FORMAT CSV, HEADER ${hasHeader ? 'true' : 'false'}, DELIMITER ${quoteString(delimiter)})`,
  );

  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  if (!fs.existsSync(fullPath)) throw new Error(`CSV 写入失败：${fullPath}`);
  ctx.log('success', `已写出 CSV：${rowCount} 行 → ${fullPath}`);
  return { rowCount, note: fullPath };
};
