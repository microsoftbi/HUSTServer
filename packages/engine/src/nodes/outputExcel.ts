import XLSX from 'xlsx';
import type { OutputExcelConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { resolveOutputPath } from '../util/io.js';
import { quoteIdent } from '../util/sqlIdent.js';

function normalizeCell(value: unknown): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    return value >= -9007199254740991n && value <= 9007199254740991n
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\[\]:*?/\\]/g, '_').slice(0, 31);
  return cleaned.length > 0 ? cleaned : 'Sheet1';
}

export const outputExcel: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Excel 输出节点缺少输入数据');

  const cfg = ctx.node.config as unknown as OutputExcelConfig;
  if (!cfg?.path) throw new Error('Excel 输出节点缺少输出路径');

  const fullPath = resolveOutputPath(cfg.path);
  const columns = await describeTable(ctx.connection, inputTable);
  const reader = await ctx.connection.runAndReadAll(
    `SELECT * FROM ${quoteIdent(inputTable)}`,
  );
  const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;

  const header = columns.map((c) => c.name);
  const aoa: Array<Array<string | number | boolean | Date | null>> = [header];
  for (const row of rows) {
    aoa.push(header.map((name) => normalizeCell(row[name])));
  }

  const sheetName = sanitizeSheetName(cfg.sheet || 'Sheet1');
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, fullPath);

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS SELECT * FROM ${quoteIdent(inputTable)}`,
  );
  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `已写出 Excel：${rowCount} 行 → ${fullPath}`);
  return { rowCount, note: fullPath };
};
