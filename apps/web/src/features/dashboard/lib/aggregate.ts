import type {
  AggregateFn,
  CellValue,
  Dataset,
  Measure,
  WidgetEncoding,
} from "@bi/types";

export interface AggregatedData {
  data: Array<Record<string, string | number | null>>;
  /** 系列 key 列表（存在 series 分组时非空） */
  series: string[];
  /** 维度字段名，作为 x 轴 dataKey */
  dimensionKey: string;
  /** 度量 key 列表（无 series 分组时使用） */
  measureKeys: string[];
}

const ALL_KEY = "__all__";

export function measureKey(m: Measure): string {
  return `${m.agg}(${m.field})`;
}

function toNumber(v: CellValue): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 对一组值应用聚合函数 */
export function applyAgg(values: CellValue[], agg: AggregateFn): number | null {
  if (agg === "count") return values.length;

  const nums = values
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(toNumber);

  if (nums.length === 0) {
    return agg === "sum" ? 0 : null;
  }

  switch (agg) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    case "none":
      return nums[0];
    default:
      return null;
  }
}

function labelOf(v: CellValue): string {
  return v === null || v === undefined || v === "" ? "(空)" : String(v);
}

/** 根据数据集与部件编码聚合出图表就绪数据 */
export function aggregate(dataset: Dataset, encoding: WidgetEncoding): AggregatedData {
  const { dimension, measures, series } = encoding;
  const colIndex = (name?: string) =>
    name ? dataset.columns.findIndex((c) => c.name === name) : -1;

  const dimIdx = colIndex(dimension);
  const seriesIdx = colIndex(series);

  const validMeasures = measures
    .map((m) => ({ ...m, idx: colIndex(m.field), key: measureKey(m) }))
    .filter((m) => m.idx >= 0);

  const dimensionKey = dimension ?? ALL_KEY;

  // 按维度分组，保持出现顺序
  const groups = new Map<string, CellValue[][]>();
  const order: string[] = [];
  for (const row of dataset.rows) {
    const key = dimIdx >= 0 ? labelOf(row[dimIdx]) : ALL_KEY;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }

  // 系列分组：仅单个度量时做透视
  if (seriesIdx >= 0 && validMeasures.length === 1) {
    const m = validMeasures[0];
    const seriesValues: string[] = [];
    const seen = new Set<string>();
    for (const row of dataset.rows) {
      const key = labelOf(row[seriesIdx]);
      if (!seen.has(key)) {
        seen.add(key);
        seriesValues.push(key);
      }
    }

    const data = order.map((dimKey) => {
      const rowsInGroup = groups.get(dimKey)!;
      const datum: Record<string, string | number | null> = { [dimensionKey]: dimKey };
      for (const sv of seriesValues) {
        const subset = rowsInGroup.filter((r) => labelOf(r[seriesIdx]) === sv);
        datum[sv] = applyAgg(
          subset.map((r) => r[m.idx]),
          m.agg,
        );
      }
      return datum;
    });

    return { data, series: seriesValues, dimensionKey, measureKeys: [m.key] };
  }

  const data = order.map((dimKey) => {
    const rowsInGroup = groups.get(dimKey)!;
    const datum: Record<string, string | number | null> = { [dimensionKey]: dimKey };
    for (const m of validMeasures) {
      datum[m.key] = applyAgg(
        rowsInGroup.map((r) => r[m.idx]),
        m.agg,
      );
    }
    return datum;
  });

  return {
    data,
    series: [],
    dimensionKey,
    measureKeys: validMeasures.map((m) => m.key),
  };
}
