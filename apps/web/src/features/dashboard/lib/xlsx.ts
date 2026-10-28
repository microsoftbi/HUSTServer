import * as XLSX from "xlsx";
import type { CellValue, Dataset, DatasetDef } from "@bi/types";
import { buildColumns, coerceRows, dedupeHeaders } from "./columns";
import { downloadBlob } from "./export";
import { uid } from "./utils";

/**
 * 在 WebView 内解析 Excel 二进制为 Dataset（取第一个工作表）。
 * @param bytes 文件二进制（由 Tauri 读取）
 * @param name 数据集名称（通常为文件名）
 * @param def 数据集定义（落库回写用）
 */
export function parseExcel(bytes: Uint8Array, name: string, def: DatasetDef): Dataset {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("Excel 文件中没有工作表");
  }

  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  }) as CellValue[][];

  const raw = matrix.filter((row) => Array.isArray(row) && row.length > 0);
  if (raw.length === 0) {
    throw new Error("Excel 工作表为空");
  }

  const headers = dedupeHeaders(raw[0].map((h) => String(h ?? "")));
  const bodyRows = raw.slice(1);
  const columns = buildColumns(headers, bodyRows);
  const rows = coerceRows(bodyRows, columns);

  return {
    id: uid("ds"),
    name,
    source: "excel",
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def,
  };
}

/* ------------------------------------------------------------ 导出 Excel */

export interface ExportSheet {
  /** 工作表名（超长 / 含非法字符时自动清理并去重） */
  name: string;
  headers: string[];
  rows: CellValue[][];
}

/** Excel 工作表名限制 31 字符且不能包含 \ / ? * [ ] : */
function sheetName(name: string, used: string[]): string {
  const base = name.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let out = base;
  let i = 2;
  while (used.includes(out)) {
    const suffix = ` (${i})`;
    out = base.slice(0, 31 - suffix.length) + suffix;
    i += 1;
  }
  return out;
}

/** 列宽：按表头与样本内容估算，避免打开后全是 #### */
function columnWidths(sheet: ExportSheet): XLSX.ColInfo[] {
  return sheet.headers.map((header, i) => {
    const sample = sheet.rows.slice(0, 100).reduce((max, row) => {
      const text = row[i] === null || row[i] === undefined ? "" : String(row[i]);
      return Math.max(max, text.length);
    }, 0);
    return { wch: Math.min(40, Math.max(10, String(header).length + 4, sample + 2)) };
  });
}

/** 把多张二维表写成一个 .xlsx 并下载（每个视觉对象一张工作表） */
export function downloadExcel(filename: string, sheets: ExportSheet[]): void {
  if (sheets.length === 0) return;
  const workbook = XLSX.utils.book_new();
  const names: string[] = [];
  for (const sheet of sheets) {
    const name = sheetName(sheet.name, names);
    names.push(name);
    const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows]);
    ws["!cols"] = columnWidths(sheet);
    XLSX.utils.book_append_sheet(workbook, ws, name);
  }
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  downloadBlob(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}
