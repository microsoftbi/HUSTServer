import Papa from "papaparse";
import type { CellValue, Dataset, DatasetDef } from "@bi/types";
import { buildColumns, coerceRows, dedupeHeaders } from "./columns";
import { uid } from "./utils";

/**
 * 在 WebView 内解析 CSV 文本为 Dataset。
 * @param text CSV 原始文本
 * @param name 数据集名称（通常为文件名）
 * @param def 数据集定义（落库回写用）
 */
export function parseCsv(text: string, name: string, def: DatasetDef): Dataset {
  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });

  const raw = (result.data as unknown as CellValue[][]).filter(
    (row) => Array.isArray(row) && row.length > 0,
  );
  if (raw.length === 0) {
    throw new Error("CSV 文件为空或无法解析");
  }

  const headers = dedupeHeaders(raw[0].map((h) => String(h ?? "")));
  const bodyRows = raw.slice(1);
  const columns = buildColumns(headers, bodyRows);
  const rows = coerceRows(bodyRows, columns);

  return {
    id: uid("ds"),
    name,
    source: "csv",
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def,
  };
}
