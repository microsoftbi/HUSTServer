import fs from 'node:fs';
import XLSX from 'xlsx';
import { dedupeNames } from './format.js';
import { resolveInputPath } from './io.js';

export interface ExcelSheetData {
  sheetName: string;
  columns: string[];
  dataRows: unknown[][];
}

/**
 * 读取 Excel 指定工作表，推导列名并返回数据行。
 * 供输入节点执行与结构探测共用，避免两处列推导逻辑漂移。
 */
export function readExcelSheet(
  path: string,
  sheet?: string,
  hasHeader = true,
): ExcelSheetData {
  const filePath = resolveInputPath(path);
  if (!fs.existsSync(filePath)) throw new Error(`Excel 文件不存在：${filePath}`);

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName =
    sheet && workbook.SheetNames.includes(sheet) ? sheet : workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel 文件不包含任何工作表');

  const sheetObj = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheetObj, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });

  let columns: string[];
  let dataRows: unknown[][];

  if (hasHeader) {
    const headerRow = matrix[0] ?? [];
    columns = dedupeNames(
      headerRow.map((v, i) =>
        v === null || v === undefined || v === '' ? `column_${i + 1}` : String(v),
      ),
    );
    dataRows = matrix.slice(1);
  } else {
    const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    columns = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
    dataRows = matrix;
  }

  return { sheetName, columns, dataRows };
}
