/** 交叉筛选/高亮：其它视觉对象按选中值过滤行后重新聚合，源视觉对象仅调整透明度 */

import type { Dataset } from "@bi/types";
import { normalizeLabel } from "./aggregate";

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
