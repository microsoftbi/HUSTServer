// 数据透视表（矩阵）数据处理：把聚合结果整理为交叉表模型，并计算行/列总计。

/** 透视表的一行：维度标签 + 各列单元格值 + 行总计 */
export interface PivotRow {
  label: string;
  cells: Array<number | null>;
  total: number;
}

export interface PivotResult {
  /** 数值列的表头（系列值或度量名） */
  columns: string[];
  rows: PivotRow[];
  /** 每一列的合计 */
  colTotals: number[];
  /** 全部单元格的总计 */
  grandTotal: number;
}

function toNumeric(v: string | number | null): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function labelOf(v: string | number | null): string {
  return v === null || v === undefined || v === "" ? "(空)" : String(v);
}

/**
 * 由聚合结果构建交叉表：行 = 维度值，列 = columnKeys。
 * 非数值单元格在展示上保留为 null，但行列合计按 0 计入。
 */
export function buildPivot(
  rows: Array<Record<string, string | number | null>>,
  dimensionKey: string,
  columnKeys: string[],
): PivotResult {
  const columns = [...columnKeys];
  const colTotals = columns.map(() => 0);
  let grandTotal = 0;

  const pivotRows: PivotRow[] = rows.map((row) => {
    const cells = columns.map((key, j) => {
      const value = toNumeric(row[key] ?? null);
      if (value !== null) colTotals[j] += value;
      return value;
    });
    const total = cells.reduce<number>((acc, v) => acc + (v ?? 0), 0);
    grandTotal += total;
    return { label: labelOf(row[dimensionKey] ?? null), cells, total };
  });

  return { columns, rows: pivotRows, colTotals, grandTotal };
}
