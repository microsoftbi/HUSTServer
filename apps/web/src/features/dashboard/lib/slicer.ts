// 切片器（Slicer）的纯函数库：取值枚举、选择状态变换、相对日期区间与筛选条件生成。
// 均为无副作用函数，便于单测；渲染与交互由 SlicerWidgetView 负责。

import type {
  CellValue,
  ChartWidget,
  ColumnType,
  Dataset,
  SlicerConfig,
  SlicerRange,
  SlicerRelative,
  SlicerSelectionMode,
  SlicerState,
  SlicerType,
} from "@bi/types";
import { normalizeLabel } from "./aggregate";
import type { ValueFilter } from "./highlight";

export const SLICER_TYPE_LABELS: Record<SlicerType, string> = {
  list: "列表",
  dropdown: "下拉",
  between: "介于",
  before: "之前",
  after: "之后",
  relativeDate: "相对日期",
  hierarchy: "层次结构",
};

export const SLICER_UNIT_LABELS = {
  day: "天",
  week: "周",
  month: "月",
  year: "年",
} as const;

export const DEFAULT_ACCENT_COLOR = "#2563eb";

export function defaultSlicerState(): SlicerState {
  return {
    selections: {},
    ranges: {},
    relative: { direction: "last", count: 30, unit: "day" },
  };
}

/** 切片器默认配置（对齐 Power BI 新建切片器时的默认值） */
export function defaultSlicer(): SlicerConfig {
  return {
    type: "list",
    selectionMode: "multi",
    showSelectAll: true,
    searchable: true,
    showHeader: true,
    horizontal: false,
    showBorder: true,
    accentColor: DEFAULT_ACCENT_COLOR,
    backgroundColor: "#ffffff",
    fontColor: "#201f1e",
    fontSize: 12,
    state: defaultSlicerState(),
  };
}

/** 读取切片器配置：旧仪表板只有 filterFields，这里补齐默认值 */
export function slicerOf(widget: ChartWidget): SlicerConfig {
  const base = defaultSlicer();
  const saved = widget.slicer;
  if (!saved) return base;
  const state = saved.state;
  return {
    ...base,
    ...saved,
    state: {
      selections: state?.selections ?? {},
      ranges: state?.ranges ?? {},
      relative: { ...base.state.relative, ...(state?.relative ?? {}) },
    },
  };
}

export function columnTypeOf(dataset: Dataset | undefined, field: string): ColumnType {
  return dataset?.columns.find((c) => c.name === field)?.type ?? "unknown";
}

/** 将单元格或输入值解析为时间戳；无法解析返回 null */
export function toEpoch(value: CellValue | string | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 仅含日期的输入（yyyy-mm-dd）按整天处理，包含当天全部时刻 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRangeDate(value: string | undefined, endOfDay = false): number | undefined {
  const t = toEpoch(value);
  if (t === null) return undefined;
  return endOfDay && value && DATE_ONLY_RE.test(value.trim())
    ? t + 86_399_999
    : t;
}

/** 字段的去重取值（已按标签归一化，空值记为「(空)」），按列类型排序 */
export function distinctValues(
  dataset: Dataset | undefined,
  field: string,
  limit = 500,
): string[] {
  if (!dataset) return [];
  const col = dataset.columns.findIndex((c) => c.name === field);
  if (col < 0) return [];
  const type = dataset.columns[col].type;
  const set = new Set<string>();
  for (const row of dataset.rows) set.add(normalizeLabel(row[col]));
  const values = [...set];
  if (type === "number") {
    values.sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  } else if (type === "date") {
    values.sort((a, b) => (toEpoch(a) ?? 0) - (toEpoch(b) ?? 0));
  } else {
    values.sort((a, b) => a.localeCompare(b, "zh-CN"));
  }
  return values.slice(0, limit);
}

/** 数值列的可用区间（用于滑块上下限） */
export function numericBounds(
  dataset: Dataset | undefined,
  field: string,
): { min: number; max: number } | null {
  if (!dataset) return null;
  const col = dataset.columns.findIndex((c) => c.name === field);
  if (col < 0 || dataset.columns[col].type !== "number") return null;
  let min = Infinity;
  let max = -Infinity;
  for (const row of dataset.rows) {
    const n = Number(row[col]);
    if (!Number.isFinite(n)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/** 写入某字段的选中值；空数组等价于「全部」 */
export function withSelection(
  state: SlicerState,
  field: string,
  values: string[],
): SlicerState {
  const selections = { ...state.selections };
  if (values.length === 0) delete selections[field];
  else selections[field] = values;
  return { ...state, selections };
}

/**
 * 点击某个值后的新状态。
 * - 单选：再次点击已选项则取消，否则替换；
 * - 多选 + ⌘/Ctrl：累加或移除；
 * - 多选：替换为单项，再次点击取消（与 Power BI 多选一致）。
 */
export function toggleSlicerValue(
  state: SlicerState,
  field: string,
  value: string,
  mode: SlicerSelectionMode,
  additive: boolean,
): SlicerState {
  const current = state.selections[field] ?? [];
  const onlyThis = current.length === 1 && current[0] === value;
  let next: string[];
  if (mode === "single") {
    next = onlyThis ? [] : [value];
  } else if (additive) {
    next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
  } else {
    next = onlyThis ? [] : [value];
  }
  return withSelection(state, field, next);
}

/** 选中「全选」：清空该字段的筛选（空即全部） */
export function selectAllValues(state: SlicerState, field: string): SlicerState {
  return withSelection(state, field, []);
}

export function setSlicerRange(
  state: SlicerState,
  field: string,
  range: SlicerRange,
): SlicerState {
  const ranges = { ...state.ranges };
  if (!range.min && !range.max) delete ranges[field];
  else ranges[field] = range;
  return { ...state, ranges };
}

export function setSlicerRelative(
  state: SlicerState,
  relative: SlicerRelative,
): SlicerState {
  return { ...state, relative };
}

/** 清除全部筛选（保留切片器类型与外观） */
export function clearSlicerState(state: SlicerState): SlicerState {
  return {
    selections: {},
    ranges: {},
    relative: state.relative,
  };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** 相对日期区间：过去/未来 N 天、周、月、年（含当天） */
export function relativeRange(
  rel: SlicerRelative,
  now: Date = new Date(),
): { from: number; to: number } {
  const count = Math.max(1, Math.round(rel.count) || 1);
  const start = startOfDay(now);
  const end = endOfDay(now);

  if (rel.direction === "last") {
    const from = new Date(start);
    if (rel.unit === "day") from.setDate(from.getDate() - (count - 1));
    else if (rel.unit === "week") from.setDate(from.getDate() - count * 7 + 1);
    else if (rel.unit === "month") from.setMonth(from.getMonth() - count, 1);
    else from.setFullYear(from.getFullYear() - count, 0, 1);
    return { from: from.getTime(), to: end.getTime() };
  }

  const to = new Date(end);
  if (rel.unit === "day") to.setDate(to.getDate() + (count - 1));
  else if (rel.unit === "week") to.setDate(to.getDate() + count * 7 - 1);
  else if (rel.unit === "month") to.setMonth(to.getMonth() + count + 1, 0);
  else to.setFullYear(to.getFullYear() + count, 11, 31);
  return { from: start.getTime(), to: to.getTime() };
}

export function rangeHasValue(range: SlicerRange | undefined): boolean {
  return !!range && (!!range.min || !!range.max);
}

/** 切片器是否正在过滤（用于显示「清除筛选」按钮） */
export function slicerActive(cfg: SlicerConfig, fields: string[]): boolean {
  if (fields.length === 0) return false;
  if (cfg.type === "relativeDate") return true;
  if (fields.some((f) => (cfg.state.selections[f]?.length ?? 0) > 0)) return true;
  if (
    (cfg.type === "between" ||
      cfg.type === "before" ||
      cfg.type === "after") &&
    fields.some((f) => rangeHasValue(cfg.state.ranges[f]))
  ) {
    return true;
  }
  return false;
}

/** 把切片器状态翻译成作用于所有视觉对象的筛选条件 */
export function slicerFilters(
  widget: ChartWidget,
  dataset: Dataset | undefined,
  now: Date = new Date(),
): ValueFilter[] {
  if (widget.type !== "filter") return [];
  const cfg = slicerOf(widget);
  const fields = widget.filterFields ?? [];
  const out: ValueFilter[] = [];

  for (const field of fields) {
    const type = columnTypeOf(dataset, field);

    if (cfg.type === "relativeDate") {
      // 相对日期仅对日期列生效；列类型未知时也按日期尝试
      if (type === "number") continue;
      const { from, to } = relativeRange(cfg.state.relative, now);
      out.push({ kind: "dateRange", field, from, to });
      continue;
    }

    if (
      cfg.type === "between" ||
      cfg.type === "before" ||
      cfg.type === "after"
    ) {
      const range = cfg.state.ranges[field];
      if (!rangeHasValue(range)) continue;
      if (type === "date") {
        const from = parseRangeDate(range?.min);
        const to = parseRangeDate(range?.max, true);
        if (from === undefined && to === undefined) continue;
        out.push({ kind: "dateRange", field, from, to });
      } else if (type === "number" || type === "unknown") {
        const min = parseNumber(range?.min);
        const max = parseNumber(range?.max);
        if (min === undefined && max === undefined) continue;
        out.push({ kind: "range", field, min, max });
      }
      continue;
    }

    const values = cfg.state.selections[field] ?? [];
    if (values.length > 0) out.push({ kind: "values", field, values });
  }

  return out;
}
