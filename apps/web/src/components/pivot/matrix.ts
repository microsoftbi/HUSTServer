// 透视矩阵成型：把后端下推聚合返回的扁平结果拼成「多级列头 + 多级行标签 + 单元格矩阵」。
// 纯函数，便于单测；所有计算都在这里完成，组件只负责渲染。

export type PivotCell = string | number | boolean | null;

export interface PivotValueMeta {
  field: string;
  agg: string;
  label: string;
}

/** 与后端 POST /api/models/pivot 的响应一一对应 */
export interface PivotRawResult {
  rowFields: string[];
  columnFields: string[];
  values: PivotValueMeta[];
  columns: Array<{ name: string; type: string }>;
  /** 每行：[行键…, 列键…, 度量值…] */
  rows: PivotCell[][];
  truncated: boolean;
  totalRows: number;
}

export interface MergedLabel {
  label: string;
  /** 该层跨越的单元格数（被合并覆盖的位置为 0） */
  span: number;
  /** 已被上层合并覆盖，渲染时跳过 */
  covered: boolean;
}

/**
 * 把「每列/每行一个标签数组」压成逐层的合并信息：同一父级下相邻同标签合并成 rowSpan/colSpan。
 * 跨父级不合并（例如 华北/2024 与 华南/2024 的两个 2024 各自独立）。
 */
export function mergeLabels(items: string[][]): MergedLabel[][] {
  const depth = items.reduce((max, labels) => Math.max(max, labels.length), 0);
  const levels: MergedLabel[][] = [];
  for (let level = 0; level < depth; level++) {
    const row: MergedLabel[] = [];
    let i = 0;
    while (i < items.length) {
      const label = items[i][level] ?? '';
      const prefix = items[i].slice(0, level).join(KEY_SEP);
      let span = 1;
      while (
        i + span < items.length &&
        (items[i + span][level] ?? '') === label &&
        items[i + span].slice(0, level).join(KEY_SEP) === prefix
      ) {
        span++;
      }
      row.push({ label, span, covered: false });
      for (let k = 1; k < span; k++) row.push({ label: '', span: 0, covered: true });
      i += span;
    }
    levels.push(row);
  }
  return levels;
}

export interface PivotColumnHeader {
  /** 列头层级标签：列维度各层 + 度量名 */
  labels: string[];
  /** 对应的度量下标（0..values.length-1） */
  valueIndex: number;
}

export interface PivotMatrix {
  /** 每行的层级标签（行维度各层，保持后端返回的出现顺序） */
  rowLabels: string[][];
  columnHeaders: PivotColumnHeader[];
  /** cells[行][列]，空组合为 null */
  cells: Array<Array<number | null>>;
  rowFieldCount: number;
  columnFieldCount: number;
  valueCount: number;
  /** 列头层级数 = 列维度数 + 1（度量名一层） */
  columnDepth: number;
  /** 行标签层级数（无行维度时为 1，用于渲染占位表头） */
  rowDepth: number;
  /** 仅当单一度量且聚合可加（sum/count）时提供，否则为 null */
  rowTotals: number[] | null;
  colTotals: number[] | null;
  grandTotal: number | null;
  rowsTruncated: boolean;
  colsTruncated: boolean;
}

/** 前端渲染上限：避免超宽/超高表格把 DOM 撑爆 */
export const PIVOT_MAX_ROWS = 500;
export const PIVOT_MAX_COLS = 200;

const EMPTY_LABEL = '(空)';
const KEY_SEP = '\u0001';

/** 维度值 → 显示标签：空值统一显示为 (空) */
export function labelOf(value: PivotCell | undefined): string {
  return value === null || value === undefined || value === '' ? EMPTY_LABEL : String(value);
}

function dimKeys(row: PivotCell[], from: number, count: number): string {
  return row.slice(from, from + count).map(labelOf).join(KEY_SEP);
}

/** sum / count 的单元格值可直接相加，avg / min / max 不行 */
function isAdditive(agg: string): boolean {
  return agg === 'sum' || agg === 'count';
}

export function buildPivotMatrix(
  raw: PivotRawResult,
  opts: { maxRows?: number; maxCols?: number } = {},
): PivotMatrix {
  const rowFieldCount = raw.rowFields.length;
  const columnFieldCount = raw.columnFields.length;
  const valueCount = raw.values.length;
  const maxRows = opts.maxRows ?? PIVOT_MAX_ROWS;
  const maxCols = opts.maxCols ?? PIVOT_MAX_COLS;

  // 行键 / 列键按出现顺序去重（后端已 ORDER BY，顺序即展示顺序）
  const rowOrder: string[] = [];
  const rowLabelsOf = new Map<string, string[]>();
  const colOrder: string[] = [];
  const colKeysOf = new Map<string, string[]>();

  for (const row of raw.rows) {
    const rk = dimKeys(row, 0, rowFieldCount);
    if (!rowLabelsOf.has(rk)) {
      rowLabelsOf.set(rk, row.slice(0, rowFieldCount).map(labelOf));
      rowOrder.push(rk);
    }
    const ck = dimKeys(row, rowFieldCount, columnFieldCount);
    if (!colKeysOf.has(ck)) {
      colKeysOf.set(ck, row.slice(rowFieldCount, rowFieldCount + columnFieldCount).map(labelOf));
      colOrder.push(ck);
    }
  }

  // 列头：每个维度组合 × 每个度量（度量名单独一层）
  const columnHeaders: PivotColumnHeader[] = [];
  for (const ck of colOrder) {
    const base = colKeysOf.get(ck) ?? [];
    for (let k = 0; k < valueCount; k++) {
      columnHeaders.push({ labels: [...base, raw.values[k].label], valueIndex: k });
    }
  }

  const rowIndex = new Map(rowOrder.map((key, i) => [key, i]));
  const colIndex = new Map(colOrder.map((key, i) => [key, i]));
  const cells: Array<Array<number | null>> = rowOrder.map(() => new Array(columnHeaders.length).fill(null));

  for (const row of raw.rows) {
    const ri = rowIndex.get(dimKeys(row, 0, rowFieldCount));
    const ci = colIndex.get(dimKeys(row, rowFieldCount, columnFieldCount));
    if (ri === undefined || ci === undefined) continue;
    const values = row.slice(rowFieldCount + columnFieldCount);
    for (let k = 0; k < valueCount; k++) {
      const cell = values[k];
      cells[ri][ci * valueCount + k] = typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
    }
  }

  // 渲染上限：截断后仍按「显示出来的单元格」计算总计，保证表内自洽
  const rowsTruncated = rowOrder.length > maxRows;
  const colsTruncated = columnHeaders.length > maxCols;
  const shownRows = rowsTruncated ? maxRows : rowOrder.length;
  const shownCols = colsTruncated ? maxCols : columnHeaders.length;
  const shownCells = cells.slice(0, shownRows).map((r) => r.slice(0, shownCols));
  const shownHeaders = columnHeaders.slice(0, shownCols);

  let rowTotals: number[] | null = null;
  let colTotals: number[] | null = null;
  let grandTotal: number | null = null;
  if (valueCount === 1 && isAdditive(raw.values[0].agg)) {
    rowTotals = shownCells.map((r) => r.reduce<number>((acc, v) => acc + (v ?? 0), 0));
    colTotals = shownHeaders.map((_, j) => shownCells.reduce<number>((acc, r) => acc + (r[j] ?? 0), 0));
    grandTotal = colTotals.reduce<number>((acc, v) => acc + v, 0);
  }

  return {
    rowLabels: rowOrder.slice(0, shownRows).map((key) => rowLabelsOf.get(key) ?? []),
    columnHeaders: shownHeaders,
    cells: shownCells,
    rowFieldCount,
    columnFieldCount,
    valueCount,
    columnDepth: columnFieldCount + 1,
    rowDepth: Math.max(1, rowFieldCount),
    rowTotals,
    colTotals,
    grandTotal,
    rowsTruncated,
    colsTruncated,
  };
}
