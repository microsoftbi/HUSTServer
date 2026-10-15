import type { CellValue } from "@bi/types";

/** 表格/预览展示用的格式化 */
export function formatCell(value: CellValue): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
