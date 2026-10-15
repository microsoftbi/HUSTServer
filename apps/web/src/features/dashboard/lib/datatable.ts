import type { CellValue } from "@bi/types";
import { formatCell } from "./format";

export type SortDirection = "asc" | "desc";

export interface SortState {
  columnIndex: number;
  direction: SortDirection;
}

/**
 * 单元格比较：空值始终排在末尾，数值按大小，其余按本地化字符串比较。
 */
function compareValues(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * 按指定列排序（返回新数组，不修改入参）。sort 为 null 时原样返回。
 */
export function sortRows(
  rows: CellValue[][],
  sort: SortState | null,
): CellValue[][] {
  if (!sort) return rows;
  const { columnIndex, direction } = sort;
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort(
    (ra, rb) => factor * compareValues(ra[columnIndex] ?? null, rb[columnIndex] ?? null),
  );
}

/**
 * 全局包含式筛选：任一单元格的展示文本命中关键字即保留（不区分大小写）。
 * 关键字为空时原样返回。
 */
export function filterRows(rows: CellValue[][], query: string): CellValue[][] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    row.some((cell) => formatCell(cell ?? null).toLowerCase().includes(q)),
  );
}

export interface PaginatedResult<T> {
  pageRows: T[];
  pageCount: number;
  /** 夹紧到有效范围的页码（从 1 开始） */
  page: number;
  /** 当前页在总数中的起始行号（从 1 开始，用于展示） */
  startIndex: number;
}

/**
 * 对行集合分页，页码自动夹紧到 [1, pageCount]。
 */
export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (safePage - 1) * size;
  return {
    pageRows: rows.slice(start, start + size),
    pageCount,
    page: safePage,
    startIndex: rows.length === 0 ? 0 : start + 1,
  };
}
