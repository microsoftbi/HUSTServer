/** 交叉筛选/高亮：其它视觉对象按选中值过滤行后重新聚合，源视觉对象仅调整透明度 */

import type { ChartWidget, Dataset } from "@bi/types";
import { hierarchyFields, normalizeLabel } from "./aggregate";

/** 作用于其它视觉对象的行级筛选条件 */
export interface CrossFilter {
  field: string;
  values: string[];
}

/**
 * 按选中维度值过滤数据集行。
 * 其它图表可各自使用不同维度字段，过滤后重新聚合即形成联动。
 * 字段不存在（例如跨数据集）或条件为空时原样返回。
 */
export function filterDataset(
  dataset: Dataset,
  filter: CrossFilter | null | undefined,
): Dataset {
  if (!filter || filter.values.length === 0) return dataset;
  const idx = dataset.columns.findIndex((c) => c.name === filter.field);
  if (idx < 0) return dataset;
  const allowed = new Set(filter.values);
  const rows = dataset.rows.filter((row) => allowed.has(normalizeLabel(row[idx])));
  return rows.length === dataset.rows.length ? dataset : { ...dataset, rows };
}

/** 仪表板级筛选条件（切片器生成）：多值 / 数值区间 / 日期区间 */
export type ValueFilter =
  | { kind: "values"; field: string; values: string[] }
  | { kind: "range"; field: string; min?: number; max?: number }
  | { kind: "dateRange"; field: string; from?: number; to?: number };

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toEpoch(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function filterByNumberRange(
  dataset: Dataset,
  field: string,
  min?: number,
  max?: number,
): Dataset {
  const idx = dataset.columns.findIndex((c) => c.name === field);
  if (idx < 0) return dataset;
  const rows = dataset.rows.filter((row) => {
    const n = toNumber(row[idx]);
    if (n === null) return false;
    if (min !== undefined && n < min) return false;
    if (max !== undefined && n > max) return false;
    return true;
  });
  return rows.length === dataset.rows.length ? dataset : { ...dataset, rows };
}

function filterByDateRange(
  dataset: Dataset,
  field: string,
  from?: number,
  to?: number,
): Dataset {
  const idx = dataset.columns.findIndex((c) => c.name === field);
  if (idx < 0) return dataset;
  const rows = dataset.rows.filter((row) => {
    const t = toEpoch(row[idx]);
    if (t === null) return false;
    if (from !== undefined && t < from) return false;
    if (to !== undefined && t > to) return false;
    return true;
  });
  return rows.length === dataset.rows.length ? dataset : { ...dataset, rows };
}

/**
 * 依次应用多个筛选条件（AND）。
 * 字段不存在或条件为空时自动跳过，其余与交叉筛选共用同一套标签归一化逻辑。
 */
export function applyValueFilters(
  dataset: Dataset,
  filters: ValueFilter[] | null | undefined,
): Dataset {
  if (!filters || filters.length === 0) return dataset;
  return filters.reduce((ds, f) => {
    if (f.kind === "values") {
      return filterDataset(ds, { field: f.field, values: f.values });
    }
    if (f.kind === "range") {
      return filterByNumberRange(ds, f.field, f.min, f.max);
    }
    return filterByDateRange(ds, f.field, f.from, f.to);
  }, dataset);
}

/**
 * 钻取层级 → 行级筛选条件：上钻路径中每一层已选中的标签值都作为值筛选，
 * 让本地聚合与服务端下推得到同一份「当前层级」数据。
 * 完整层级为 X 轴字段 → 钻取井字段，第 i 层对应 selections[i]。
 */
export function drillValueFilters(widget: ChartWidget): ValueFilter[] {
  const drill = widget.drill;
  if (!drill || drill.selections.length === 0) return [];
  const fields = hierarchyFields(widget.encoding, drill);
  const depth = Math.min(
    drill.level,
    fields.length - 1,
    drill.selections.length,
  );
  const filters: ValueFilter[] = [];
  for (let i = 0; i < depth; i += 1) {
    const field = fields[i];
    const value = drill.selections[i];
    if (!field || value === undefined) continue;
    filters.push({ kind: "values", field, values: [value] });
  }
  return filters;
}

export interface HighlightSelection {
  /** 参与高亮的维度字段名 */
  field: string;
  /** 选中的维度值（已按标签字符串归一化） */
  values: string[];
  /** 触发高亮的视觉对象 id */
  sourceId: string;
}

/** 未命中项默认变暗透明度 */
export const DIM_OPACITY = 0.25;

/**
 * 计算某个元素的透明度。
 * - 无选中、或该视觉对象未按选中字段分组时保持 1；
 * - 分组字段与选中字段一致时，值命中选中的值返回 1，否则返回变暗透明度。
 */
export function cellOpacity(
  selection: HighlightSelection | null,
  field: string | undefined,
  value: string,
  dimOpacity = DIM_OPACITY,
): number {
  if (!selection || !field || selection.field !== field) return 1;
  return selection.values.includes(value) ? 1 : dimOpacity;
}

/**
 * 点击某个元素后推导新的选中状态。
 * - additive（⌘/Ctrl）且同源同字段：累加或移除，空则清除；
 * - 非累加且同源同字段：点击唯一已选项则清除，否则替换；
 * - 其余情况（换值/换来源/首次）：替换为新选中。
 */
export function toggleSelection(
  prev: HighlightSelection | null,
  field: string,
  value: string,
  sourceId: string,
  additive: boolean,
): HighlightSelection | null {
  const sameTarget =
    prev !== null && prev.field === field && prev.sourceId === sourceId;

  if (additive && sameTarget) {
    const values = prev!.values.includes(value)
      ? prev!.values.filter((v) => v !== value)
      : [...prev!.values, value];
    return values.length > 0 ? { field, values, sourceId } : null;
  }

  if (sameTarget && prev!.values.length === 1 && prev!.values[0] === value) {
    return null;
  }

  return { field, values: [value], sourceId };
}
