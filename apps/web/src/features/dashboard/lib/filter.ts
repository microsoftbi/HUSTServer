// 筛选器窗格的纯函数：把筛选器卡片翻译成引擎可用的行级筛选条件。
// 报表级 / 页面级 / 视觉对象级的筛选器都按 datasetId 归属，避免同名字段跨数据集误伤。

import type { Dataset, FilterCondition } from "@bi/types";
import { normalizeLabel } from "./aggregate";
import type { ValueFilter } from "./highlight";

/** 筛选器是否正在生效（空值数组表示「全部」） */
export function filterIsActive(condition: FilterCondition): boolean {
  const mode = condition.mode ?? "basic";
  if (mode === "range") {
    return !!condition.min?.trim() || !!condition.max?.trim();
  }
  if (mode === "topN") {
    return (condition.n ?? 0) > 0;
  }
  return condition.values.length > 0;
}

/** 前 N 项：按行数取出现次数最多的标签值 */
function topValues(dataset: Dataset, field: string, n: number): string[] {
  const idx = dataset.columns.findIndex((c) => c.name === field);
  if (idx < 0 || n <= 0) return [];
  const count = new Map<string, number>();
  for (const row of dataset.rows) {
    const key = normalizeLabel(row[idx]);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value]) => value);
}

/** 区间筛选：日期列转时间戳区间，其余列按数值区间 */
function rangeFilter(
  dataset: Dataset,
  condition: FilterCondition,
): ValueFilter | null {
  const minText = condition.min?.trim() ?? "";
  const maxText = condition.max?.trim() ?? "";
  if (!minText && !maxText) return null;
  const column = dataset.columns.find((c) => c.name === condition.field);
  if (column?.type === "date") {
    const from = minText ? Date.parse(minText) : undefined;
    const to = maxText ? Date.parse(maxText) : undefined;
    const safeFrom = Number.isNaN(from) ? undefined : from;
    const safeTo = Number.isNaN(to) ? undefined : to;
    if (safeFrom === undefined && safeTo === undefined) return null;
    return { kind: "dateRange", field: condition.field, from: safeFrom, to: safeTo };
  }
  const min = minText ? Number(minText) : undefined;
  const max = maxText ? Number(maxText) : undefined;
  const safeMin = Number.isFinite(min) ? min : undefined;
  const safeMax = Number.isFinite(max) ? max : undefined;
  if (safeMin === undefined && safeMax === undefined) return null;
  return { kind: "range", field: condition.field, min: safeMin, max: safeMax };
}

/** 取出属于指定数据集的生效条件，转换为行级筛选条件 */
export function conditionFilters(
  conditions: FilterCondition[] | null | undefined,
  dataset: Dataset | undefined,
): ValueFilter[] {
  if (!dataset || !conditions || conditions.length === 0) return [];
  const out: ValueFilter[] = [];
  for (const c of conditions) {
    if (c.datasetId !== dataset.id) continue;
    const mode = c.mode ?? "basic";
    if (mode === "range") {
      const f = rangeFilter(dataset, c);
      if (f) out.push(f);
      continue;
    }
    if (mode === "topN") {
      const values = topValues(dataset, c.field, c.n ?? 0);
      if (values.length > 0) {
        out.push({ kind: "values", field: c.field, values });
      }
      continue;
    }
    if (c.values.length > 0) {
      out.push({ kind: "values", field: c.field, values: c.values });
    }
  }
  return out;
}
