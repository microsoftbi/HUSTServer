import { useMemo } from "react";
import { buildPivot } from "@bi/lib/pivot";
import { formatCell } from "@bi/lib/format";
import type { CellDecor } from "@bi/lib/conditional";
import type { CellValue, FieldFormat } from "@bi/types";
import { cellOpacity, type HighlightSelection } from "@bi/lib/highlight";

interface PivotTableProps {
  /** 聚合后的数据 */
  rows: Array<Record<string, string | number | null>>;
  /** 行（维度）字段名 */
  dimensionKey: string;
  /** 数值列表头（系列值或度量名） */
  columnKeys: string[];
  /** 是否显示行/列总计 */
  showTotals?: boolean;
  /** 当前交叉高亮状态 */
  highlight?: HighlightSelection | null;
  /** 字段级数值格式（key 为列名） */
  formats?: Record<string, FieldFormat>;
  /** 条件格式装饰：按列名与单元格值返回装饰（数据条 / 色阶 / 图标 / 规则） */
  decor?: (column: string, value: CellValue) => CellDecor | null;
  /** 点击行回调：field 为行字段，value 为行标签 */
  onPointClick?: (field: string, value: string, additive: boolean) => void;
}

/** 数据透视表（矩阵）：行 = 维度、列 = 系列/度量，带行列总计 */
export function PivotTable({
  rows,
  dimensionKey,
  columnKeys,
  showTotals = true,
  highlight = null,
  formats,
  decor,
  onPointClick,
}: PivotTableProps) {
  const pivot = useMemo(
    () => buildPivot(rows, dimensionKey, columnKeys),
    [rows, dimensionKey, columnKeys],
  );

  if (pivot.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        无数据
      </div>
    );
  }

  const headCell =
    "whitespace-nowrap border-b border-r px-3 py-2 font-medium";
  const bodyCell = "whitespace-nowrap border-b border-r px-3 py-1.5";

  return (
    <div className="h-full w-full overflow-auto rounded-md border">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
          <tr>
            <th
              className={`${headCell} sticky left-0 z-20 bg-muted text-left`}
            >
              {dimensionKey}
            </th>
            {pivot.columns.map((c, i) => (
              <th key={`${c}-${i}`} className={`${headCell} text-right`}>
                {c}
              </th>
            ))}
            {showTotals ? (
              <th className={`${headCell} text-right font-semibold`}>总计</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {pivot.rows.map((row, ri) => (
            <tr
              key={ri}
              className={`even:bg-muted/30 hover:bg-accent/50 ${
                onPointClick ? "cursor-pointer" : ""
              }`}
              style={{
                opacity: cellOpacity(highlight, dimensionKey, row.label),
              }}
              onClick={
                onPointClick
                  ? (e) =>
                      onPointClick(
                        dimensionKey,
                        row.label,
                        e.metaKey || e.ctrlKey,
                      )
                  : undefined
              }
            >
              <th
                className={`${bodyCell} sticky left-0 z-10 bg-card text-left font-normal`}
              >
                {row.label}
              </th>
              {row.cells.map((v, ci) => {
                const key = pivot.columns[ci];
                const d = decor?.(key, v);
                return (
                  <td
                    key={ci}
                    className={`${bodyCell} relative text-right tabular-nums ${
                      d?.bold ? "font-semibold" : ""
                    }`}
                    style={{
                      background: d?.background,
                      color: d?.color,
                    }}
                  >
                    {d?.bar ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0"
                        style={{
                          width: `${Math.round(d.bar.ratio * 100)}%`,
                          background: d.bar.color,
                          opacity: 0.28,
                        }}
                      />
                    ) : null}
                    <span className="relative inline-flex items-center gap-1">
                      {d?.icon ? (
                        <span
                          aria-hidden
                          className="text-[10px] leading-none"
                          style={{ color: d.iconColor }}
                        >
                          {d.icon === "up" ? "▲" : d.icon === "flat" ? "■" : "▼"}
                        </span>
                      ) : null}
                      {formatCell(v, formats?.[key])}
                    </span>
                  </td>
                );
              })}
              {showTotals ? (
                <td className={`${bodyCell} text-right font-medium tabular-nums`}>
                  {formatCell(row.total, formats?.[pivot.columns[0]])}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        {showTotals ? (
          <tfoot className="sticky bottom-0 z-10 bg-muted font-medium">
            <tr>
              <th
                className={`${headCell} sticky left-0 z-20 bg-muted text-left`}
              >
                总计
              </th>
              {pivot.colTotals.map((v, i) => (
                <td
                  key={i}
                  className={`${headCell} text-right tabular-nums`}
                >
                  {formatCell(v, formats?.[pivot.columns[i]])}
                </td>
              ))}
              <td className={`${headCell} text-right font-semibold tabular-nums`}>
                {formatCell(pivot.grandTotal, formats?.[pivot.columns[0]])}
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
