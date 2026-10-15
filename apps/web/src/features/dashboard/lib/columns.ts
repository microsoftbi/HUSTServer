import type { CellValue, Column, ColumnType } from "@bi/types";

/** 根据一列的值推断其类型（布尔 > 数值 > 日期 > 字符串） */
export function inferColumnType(values: CellValue[]): ColumnType {
  let hasValue = false;
  let allBoolean = true;
  let allNumber = true;
  let allDate = true;

  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    hasValue = true;
    const s = String(v).trim();
    if (!/^(true|false)$/i.test(s)) allBoolean = false;
    if (s === "" || Number.isNaN(Number(s))) allNumber = false;
    if (Number.isNaN(Date.parse(s))) allDate = false;
  }

  if (!hasValue) return "string";
  if (allBoolean) return "boolean";
  if (allNumber) return "number";
  // 纯数字字符串已被 number 命中；此处仅日期
  if (allDate) return "date";
  return "string";
}

/** 将单元格原始值按目标类型转换 */
export function coerceCell(value: CellValue, type: ColumnType): CellValue {
  if (value === null || value === undefined || value === "") return null;

  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return String(value).trim().toLowerCase() === "true";
    case "date": {
      const t = Date.parse(String(value));
      return Number.isNaN(t) ? String(value) : new Date(t).toISOString();
    }
    default:
      return String(value);
  }
}

export function buildColumns(headers: string[], rows: CellValue[][]): Column[] {
  return headers.map((name, i) => ({
    name: name?.trim() ? String(name).trim() : `列${i + 1}`,
    type: inferColumnType(rows.map((r) => r[i] ?? null)),
  }));
}

export function coerceRows(rows: CellValue[][], columns: Column[]): CellValue[][] {
  return rows.map((row) => columns.map((c, i) => coerceCell(row[i] ?? null, c.type)));
}

/** 去重表头，避免重名列导致后续按名取值出错 */
export function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h?.trim() ? String(h).trim() : `列${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  });
}
