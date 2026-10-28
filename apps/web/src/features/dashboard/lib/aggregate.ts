import type {
  AggregateFn,
  CellValue,
  Dataset,
  DrillState,
  Measure,
  TimeCompare,
  WidgetEncoding,
  WidgetSort,
  WidgetTopN,
} from "@bi/types";
import {
  alignPreviousPeriod,
  baseAggKey,
  collectBaseAggs,
  compileMeasure,
  evaluateMeasure,
  periodKeyOf,
  timeCompareLabel,
  type BaseAgg,
  type CompiledMeasure,
} from "./measure";

export interface AggregatedData {
  data: Array<Record<string, string | number | null>>;
  /** 系列 key 列表（存在 series 分组时非空） */
  series: string[];
  /** 维度字段名，作为 x 轴 dataKey（多级分组时为各级字段名拼接） */
  dimensionKey: string;
  /** 度量 key 列表（无 series 分组时使用） */
  measureKeys: string[];
  /** 多级分组：类别标签 → 各层原始值（下钻定位用；单级分组时为空） */
  dimensionPaths?: Record<string, string[]>;
}

const ALL_KEY = "__all__";

/** 多级分组的类别标签分隔符（对齐 Power BI 展开视图的「父 / 子」层级轴） */
export const LEVEL_SEP = " / ";

/** Top N 合并后的分组标签（对齐 Power BI 的「其他」） */
export const OTHERS_LABEL = "其它";

export function measureKey(m: Measure): string {
  // 命名度量直接以度量名作为列 key，图表 / 表格里显示的就是「本月销售额」
  return m.measureId ? m.field : baseAggKey(m.agg as Exclude<AggregateFn, "none">, m.field);
}

/** X 轴字段（第 1 层为主维度，其余依次成层） */
export function axisFields(encoding: WidgetEncoding): string[] {
  const first = encoding.dimension;
  if (!first) return [];
  const extra = (encoding.extraDimensions ?? []).filter((f) => f !== first);
  return [first, ...extra];
}

/**
 * 完整钻取层级：X 轴字段 → 钻取井字段。
 * 第 0 层为主维度，之后依次向下。
 */
export function hierarchyFields(
  encoding: WidgetEncoding,
  drill?: DrillState,
): string[] {
  const axis = axisFields(encoding);
  const path = (drill?.path ?? []).filter((f) => !axis.includes(f));
  return [...axis, ...path];
}

/**
 * 当前生效的分组维度：
 * - 未下钻（或回到顶层）时展示 X 轴全部字段：拖入多个维度即自动成层；
 * - 钻取模式只看当前层（`[fields[level]]`）；
 * - 展开模式同时显示 0…level 各层，构成层级轴。
 */
export function effectiveDimensions(
  encoding: WidgetEncoding,
  drill?: DrillState,
): string[] {
  const fields = hierarchyFields(encoding, drill);
  if (fields.length === 0) return [];
  const root = fields.slice(0, Math.max(axisFields(encoding).length, 1));
  if (!drill || drill.level <= 0) return root;
  const level = Math.min(drill.level, fields.length - 1);
  if (drill.mode === "expand") return fields.slice(0, level + 1);
  return [fields[level]];
}

/** 可加聚合（Top N 的其余分组可合并为「其它」） */
function isAdditiveKey(key: string): boolean {
  return key.startsWith("sum(") || key.startsWith("count(");
}

/**
 * 视觉对象级后处理：排序 → 取前 N 项 → 其余合并为「其它」。
 * 服务端下推与本地聚合共用同一套口径，避免两种数据来源行为不一致。
 */
export function applyViewOptions(
  agg: AggregatedData,
  opts: { sort?: WidgetSort; topN?: WidgetTopN },
): AggregatedData {
  const { sort, topN } = opts;
  if (!sort && !topN) return agg;
  // 有系列分组时透视后的列即系列值，否则为度量 key
  const valueKeys = agg.series.length > 0 ? agg.series : agg.measureKeys;
  if (valueKeys.length === 0 || agg.data.length === 0) return agg;

  const numOf = (row: Record<string, string | number | null>, key: string): number => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };

  /** 排序依据的度量 key：显式指定且存在时使用，否则按首个度量 / 系列合计 */
  const sortKey =
    sort?.by === "measure" &&
    sort.measure &&
    (valueKeys.includes(sort.measure) || agg.measureKeys.includes(sort.measure))
      ? sort.measure
      : undefined;

  /** 排序取值：系列分组时按各系列合计（与 Power BI 的 Top N 口径一致） */
  const sortValueOf = (row: Record<string, string | number | null>): number => {
    if (sortKey) return numOf(row, sortKey);
    if (agg.series.length > 0) {
      return valueKeys.reduce((acc, key) => acc + numOf(row, key), 0);
    }
    return numOf(row, agg.measureKeys[0] ?? valueKeys[0]);
  };

  const byLabel = (a: Record<string, string | number | null>, b: Record<string, string | number | null>) =>
    String(a[agg.dimensionKey] ?? "").localeCompare(
      String(b[agg.dimensionKey] ?? ""),
      "zh-CN",
      { numeric: true },
    );

  const rows = [...agg.data];
  if (sort?.by === "dimension") {
    rows.sort((a, b) => (sort.desc ? -byLabel(a, b) : byLabel(a, b)));
  } else if (sort?.by === "measure" || topN) {
    // 设置 Top N 但未指定排序时，默认按首个度量降序（与 Power BI 一致）
    const desc = sort?.by === "measure" ? sort.desc : true;
    rows.sort((a, b) => (desc ? sortValueOf(b) - sortValueOf(a) : sortValueOf(a) - sortValueOf(b)));
  }

  if (!topN || !Number.isFinite(topN.n) || topN.n <= 0 || rows.length <= topN.n) {
    return { ...agg, data: rows };
  }

  const head = rows.slice(0, topN.n);
  if (!topN.other) return { ...agg, data: head };

  // 仅可加聚合能安全合并「其它」（avg / min / max 合并会失真，此时只截断）
  const additiveOf = (key: string) =>
    agg.series.length > 0 ? isAdditiveKey(agg.measureKeys[0] ?? "") : isAdditiveKey(key);
  if (!valueKeys.some(additiveOf)) return { ...agg, data: head };

  const rest = rows.slice(topN.n);
  const others: Record<string, string | number | null> = {
    [agg.dimensionKey]: OTHERS_LABEL,
  };
  for (const key of valueKeys) {
    others[key] = additiveOf(key)
      ? rest.reduce((acc, row) => acc + numOf(row, key), 0)
      : null;
  }
  return { ...agg, data: [...head, others] };
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

/** 归一化单元格标签（空值统一为「(空)」），交叉筛选按同一规则匹配 */
export function normalizeLabel(v: CellValue): string {
  return v === null || v === undefined || v === "" ? "(空)" : String(v);
}

/** 根据数据集与部件编码聚合出图表就绪数据 */
export function aggregate(
  dataset: Dataset,
  encoding: WidgetEncoding,
  dimensions: string[] = axisFields(encoding),
): AggregatedData {
  const { measures, series } = encoding;
  const colIndex = (name?: string) =>
    name ? dataset.columns.findIndex((c) => c.name === name) : -1;

  const dims = dimensions
    .map((name) => ({ name, idx: colIndex(name) }))
    .filter((d) => d.idx >= 0);
  /** 多级分组：展开视图 / X 轴多字段时按层级路径分组 */
  const multi = dims.length > 1;
  const seriesIdx = colIndex(series);

  /**
   * 度量槽位：普通聚合直接取列；命名度量按表达式求值。
   * 表达式依赖的基础聚合先行计算，再逐行代入，保证与手写 `sum(...)` 一致。
   */
  type Slot =
    | { kind: "base"; key: string; idx: number; agg: AggregateFn }
    | {
        kind: "named";
        key: string;
        name: string;
        compiled: CompiledMeasure;
        timeCompare?: TimeCompare;
      };

  const namedDefs = dataset.measures ?? {};
  const compiledByName = new Map<string, CompiledMeasure>();
  const slots: Slot[] = [];
  for (const m of measures) {
    if (m.measureId) {
      const def = namedDefs[m.measureId];
      if (!def) continue;
      const compiled = compileMeasure(def);
      if (compiled.error || !compiled.ast) continue;
      if (compiled.fields.some((f) => colIndex(f) < 0)) continue;
      compiledByName.set(def.name, compiled);
      slots.push({
        kind: "named",
        key: def.name,
        name: def.name,
        compiled,
        timeCompare: def.timeCompare,
      });
      continue;
    }
    const idx = colIndex(m.field);
    if (idx < 0) continue;
    slots.push({ kind: "base", key: measureKey(m), idx, agg: m.agg });
  }

  const hasNamed = slots.some((s) => s.kind === "named");
  const baseAggs: BaseAgg[] = collectBaseAggs(compiledByName.values());
  const baseIdx = new Map(baseAggs.map((b) => [b.key, colIndex(b.field)]));

  /** 一组行 → 表达式需要的基础聚合值 */
  const baseValuesOf = (rows: CellValue[][]): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const b of baseAggs) {
      const idx = baseIdx.get(b.key) ?? -1;
      out[b.key] = idx >= 0 ? applyAgg(rows.map((r) => r[idx]), b.agg) : null;
    }
    return out;
  };

  const valueOf = (
    rows: CellValue[][],
    slot: Slot,
    baseValues?: Record<string, number | null>,
  ): number | null => {
    if (slot.kind === "base") return applyAgg(rows.map((r) => r[slot.idx]), slot.agg);
    return evaluateMeasure(slot.name, compiledByName, baseValues ?? baseValuesOf(rows));
  };

  const dimensionKey =
    dims.length === 0
      ? ALL_KEY
      : multi
        ? dims.map((d) => d.name).join(LEVEL_SEP)
        : dims[0].name;

  /** 分组标签：多级时拼成「父 / 子」，单级保持原标签 */
  const labelOf = (parts: string[]) => (multi ? parts.join(LEVEL_SEP) : (parts[0] ?? ALL_KEY));

  // 按层级路径分组，保持出现顺序
  const groups = new Map<string, { parts: string[]; rows: CellValue[][] }>();
  const order: string[] = [];
  for (const row of dataset.rows) {
    const parts = dims.map((d) => normalizeLabel(row[d.idx]));
    const key = parts.length === 0 ? ALL_KEY : parts.join("\u0001");
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { parts, rows: [] };
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.rows.push(row);
  }

  const dimensionPaths: Record<string, string[]> = {};
  if (multi) {
    for (const key of order) {
      const parts = groups.get(key)!.parts;
      dimensionPaths[labelOf(parts)] = parts;
    }
  }
  const paths = multi ? { dimensionPaths } : {};

  // 系列分组：仅单个度量时做透视
  if (seriesIdx >= 0 && slots.length === 1) {
    const slot = slots[0];
    const seriesValues: string[] = [];
    const seen = new Set<string>();
    for (const row of dataset.rows) {
      const key = normalizeLabel(row[seriesIdx]);
      if (!seen.has(key)) {
        seen.add(key);
        seriesValues.push(key);
      }
    }

    const data = order.map((key) => {
      const group = groups.get(key)!;
      const datum: Record<string, string | number | null> = {
        [dimensionKey]: labelOf(group.parts),
      };
      for (const sv of seriesValues) {
        const subset = group.rows.filter((r) => normalizeLabel(r[seriesIdx]) === sv);
        datum[sv] = valueOf(subset, slot, hasNamed ? baseValuesOf(subset) : undefined);
      }
      return datum;
    });

    return { data, series: seriesValues, dimensionKey, measureKeys: [slot.key], ...paths };
  }

  const data = order.map((key) => {
    const group = groups.get(key)!;
    const datum: Record<string, string | number | null> = {
      [dimensionKey]: labelOf(group.parts),
    };
    const baseValues = hasNamed ? baseValuesOf(group.rows) : undefined;
    for (const slot of slots) {
      datum[slot.key] = valueOf(group.rows, slot, baseValues);
    }
    return datum;
  });

  const measureKeys = slots.map((s) => s.key);

  // 时间对比：按日期维度逐行对齐上一周期，追加「同比 / 环比」列
  for (const slot of slots) {
    if (slot.kind !== "named" || !slot.timeCompare) continue;
    const { kind } = slot.timeCompare;
    const field =
      slot.timeCompare.field ??
      dims.find((d) => dataset.columns[d.idx]?.type === "date")?.name;
    const dateIdx = colIndex(field);
    if (dateIdx < 0) continue;
    const periods = order.map((key) => singlePeriodOf(groups.get(key)!.rows, dateIdx, kind));
    const prev = alignPreviousPeriod(
      order.map((key, i) => ({
        label: labelOf(groups.get(key)!.parts),
        period: periods[i],
        value: valueOf(groups.get(key)!.rows, slot, hasNamed ? baseValuesOf(groups.get(key)!.rows) : undefined),
      })),
      kind,
    );
    const compareKey = `${slot.key}（${timeCompareLabel(kind)}）`;
    measureKeys.push(compareKey);
    data.forEach((datum, i) => {
      datum[compareKey] = prev[i];
    });
  }

  return { data, series: [], dimensionKey, measureKeys, ...paths };
}

/** 一组行在某个日期字段上是否只落在一个统计周期内（否则无法做同比 / 环比对齐） */
function singlePeriodOf(
  rows: CellValue[][],
  dateIdx: number,
  kind: TimeCompare["kind"],
): string | null {
  const keys = new Set<string>();
  for (const row of rows) {
    const p = periodKeyOf(row[dateIdx], kind);
    if (p) keys.add(p);
    if (keys.size > 1) return null;
  }
  return keys.size === 1 ? [...keys][0] : null;
}
