import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import type { CellValue, FieldFormat } from "@bi/types";
import { formatCell } from "@bi/lib/format";
import { filterRows, paginate, sortRows, type SortState } from "@bi/lib/datatable";
import { Input } from "@bi/components/ui/input";
import { cn } from "@bi/lib/utils";

export interface DataTableColumn {
  name: string;
  type?: string;
}

interface DataTableProps {
  columns: DataTableColumn[];
  rows: CellValue[][];
  /** 每页行数 */
  pageSize?: number;
  /** 是否显示搜索框（小表格可关闭） */
  searchable?: boolean;
  /** 字段级数值格式：列名 → 格式 */
  formats?: Record<string, FieldFormat>;
  className?: string;
}

/** 通用数据预览表格（数据源预览 / 查询结果预览共用） */
export function DataTable({
  columns,
  rows,
  pageSize = 50,
  searchable = true,
  formats,
  className,
}: DataTableProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(1);

  const { pageRows, pageCount, page: safePage, startIndex } = useMemo(() => {
    const filtered = filterRows(rows, query);
    const sorted = sortRows(filtered, sort);
    return paginate(sorted, page, pageSize);
  }, [rows, query, sort, page, pageSize]);

  const filteredCount = useMemo(
    () => filterRows(rows, query).length,
    [rows, query],
  );

  function toggleSort(columnIndex: number) {
    setPage(1);
    setSort((prev) => {
      if (prev?.columnIndex !== columnIndex) {
        return { columnIndex, direction: "asc" };
      }
      if (prev.direction === "asc") return { columnIndex, direction: "desc" };
      return null;
    });
  }

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无数据
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      {searchable ? (
        <div className="relative mb-2 w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="搜索全部列…"
            className="h-8 pl-8 text-sm"
          />
        </div>
      ) : null}

      <div className="flex-1 overflow-auto rounded-md border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            <tr>
              <th className="w-10 border-b border-r px-2 py-2 text-right font-medium text-muted-foreground">
                #
              </th>
              {columns.map((c, i) => {
                const active = sort?.columnIndex === i;
                const Icon = !active
                  ? ArrowUpDown
                  : sort?.direction === "asc"
                    ? ArrowUp
                    : ArrowDown;
                return (
                  <th
                    key={`${c.name}-${i}`}
                    className="whitespace-nowrap border-b border-r p-0 text-left font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(i)}
                      className="flex w-full items-baseline gap-2 px-3 py-2 hover:bg-accent/60"
                    >
                      <span>{c.name}</span>
                      {c.type ? (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {c.type}
                        </span>
                      ) : null}
                      <Icon
                        className={cn(
                          "ml-auto h-3.5 w-3.5",
                          active ? "text-foreground" : "text-muted-foreground/50",
                        )}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr key={startIndex + ri} className="even:bg-muted/30 hover:bg-accent/50">
                <td className="border-b border-r px-2 py-1.5 text-right text-xs text-muted-foreground">
                  {startIndex + ri}
                </td>
                {columns.map((col, ci) => (
                  <td
                    key={ci}
                    className="max-w-[320px] truncate whitespace-nowrap border-b border-r px-3 py-1.5"
                  >
                    {formatCell(row[ci] ?? null, formats?.[col.name])}
                  </td>
                ))}
              </tr>
            ))}
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  无匹配数据
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-1 pt-2 text-xs text-muted-foreground">
        <span>
          共 {filteredCount} 行 · {columns.length} 列
          {query.trim() && filteredCount !== rows.length
            ? `（已从 ${rows.length} 行中筛选）`
            : ""}
        </span>
        {pageCount > 1 ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="上一页"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
              className="rounded p-1 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span>
              第 {safePage} / {pageCount} 页
            </span>
            <button
              type="button"
              aria-label="下一页"
              disabled={safePage >= pageCount}
              onClick={() => setPage(safePage + 1)}
              className="rounded p-1 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
