import * as XLSX from "xlsx";
import type { CellValue, Dataset, DatasetDef } from "@bi/types";
import { buildColumns, coerceRows, dedupeHeaders } from "./columns";
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
