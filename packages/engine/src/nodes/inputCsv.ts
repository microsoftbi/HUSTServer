import fs from 'node:fs';
import type { InputCsvConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { normalizeDelimiter } from '../util/format.js';
import { decodeFileToUtf8, resolveInputPath, safeUnlink, tempPath } from '../util/io.js';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';

export const inputCsv: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as InputCsvConfig;
  if (!cfg?.path) throw new Error('CSV 输入节点缺少文件路径');

  const sourcePath = resolveInputPath(cfg.path);
  if (!fs.existsSync(sourcePath)) throw new Error(`CSV 文件不存在：${sourcePath}`);

  const delimiter = normalizeDelimiter(cfg.delimiter);
  const hasHeader = cfg.hasHeader !== false;

  let readPath = sourcePath;
  let tempFile: string | null = null;
  if (cfg.encoding === 'gbk') {
    const text = decodeFileToUtf8(sourcePath, 'gbk');
    tempFile = tempPath('.csv');
    fs.writeFileSync(tempFile, text, 'utf-8');
    readPath = tempFile;
  }

  try {
    await ctx.connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
       SELECT * FROM read_csv_auto(${quoteString(readPath)}, delim = ${quoteString(delimiter)}, header = ${hasHeader ? 'true' : 'false'}, sample_size = -1)`,
    );
    const rowCount = await countRows(ctx.connection, ctx.outputTable);
    ctx.log('success', `已读取 CSV：${rowCount} 行`);
    return { rowCount };
  } finally {
    if (tempFile) safeUnlink(tempFile);
  }
};
