import type { InputExcelConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { materializeRows } from '../engine/ingest.js';
import { readExcelSheet } from '../util/excel.js';

export const inputExcel: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as InputExcelConfig;
  if (!cfg?.path) throw new Error('Excel 输入节点缺少文件路径');

  const { sheetName, columns, dataRows } = readExcelSheet(
    cfg.path,
    cfg.sheet,
    cfg.hasHeader !== false,
  );

  const rows = dataRows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column] = row[index] ?? null;
    });
    return record;
  });

  const rowCount = await materializeRows(ctx.connection, ctx.outputTable, rows, columns);
  ctx.log('success', `已读取 Excel 工作表「${sheetName}」：${rowCount} 行`);
  return { rowCount, note: sheetName };
};
