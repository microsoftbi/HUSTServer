import type {
  CellValue,
  ChartWidget,
  ConditionalFormat,
  ConditionalRule,
} from "@bi/types";

/** 条件格式默认值（对齐 Power BI 的默认配色） */
export const DEFAULT_CONDITIONAL: ConditionalFormat = {
  mode: "none",
  fields: [],
  barColor: "#3b82f6",
  minColor: "#f8696b",
  midColor: "#ffeb84",
  maxColor: "#63be7b",
  threeColor: true,
  iconColor: "#3b82f6",
  rules: [],
};

export const CONDITIONAL_MODES: Array<{
  value: ConditionalFormat["mode"];
  label: string;
}> = [
  { value: "none", label: "无" },
  { value: "dataBar", label: "数据条" },
  { value: "colorScale", label: "色阶" },
  { value: "iconSet", label: "图标" },
  { value: "rules", label: "规则" },
];

export const OPERATOR_OPTIONS: Array<{
  value: ConditionalRule["operator"];
  label: string;
}> = [
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
  { value: "eq", label: "等于" },
];

export const THRESHOLD_OPTIONS: Array<{
  value: ConditionalRule["threshold"];
  label: string;
}> = [
  { value: "value", label: "固定值" },
  { value: "avg", label: "平均值" },
  { value: "median", label: "中位数" },
  { value: "max", label: "最大值" },
  { value: "min", label: "最小值" },
];

/** 读取视觉对象的条件格式配置；未启用时返回 null */
export function conditionalOf(widget: ChartWidget): ConditionalFormat | null {
  const cfg = widget.conditional;
  if (!cfg || cfg.mode === "none") return null;
  return {
    ...DEFAULT_CONDITIONAL,
    ...cfg,
    rules: cfg.rules ?? [],
    fields: cfg.fields ?? [],
  };
}

/** 条件格式是否作用于某个度量列（聚合 key） */
export function appliesTo(cfg: ConditionalFormat, key: string): boolean {
  const fields = cfg.fields ?? [];
  return fields.length === 0 || fields.includes(key);
}

export interface ValueRange {
  min: number;
  max: number;
  avg: number;
  median: number;
}

/** 计算一列数值的统计范围（忽略 null / 非数字） */
export function rangeOf(values: CellValue[]): ValueRange | null {
  const nums = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / nums.length,
    median,
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 按比例混合两个颜色（t=0 取 a，t=1 取 b） */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const k = clamp01(t);
  return toHex([
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k,
  ]);
}

/** 值在区间中的位置（0-1） */
export function ratioOf(value: number, range: ValueRange): number {
  const span = range.max - range.min;
  if (span <= 0) return 1;
  return clamp01((value - range.min) / span);
}

/** 色阶取色：三色时以中位数/区间中点作为中间色锚点 */
export function scaleColor(
  value: number,
  range: ValueRange,
  cfg: ConditionalFormat,
): string {
  const ratio = ratioOf(value, range);
  if (!cfg.threeColor) return mixHex(cfg.minColor, cfg.maxColor, ratio);
  if (ratio <= 0.5) return mixHex(cfg.minColor, cfg.midColor, ratio * 2);
  return mixHex(cfg.midColor, cfg.maxColor, (ratio - 0.5) * 2);
}

/** 规则阈值：固定值或列统计量 */
function thresholdOf(rule: ConditionalRule, range: ValueRange): number {
  switch (rule.threshold) {
    case "avg":
      return range.avg;
    case "median":
      return range.median;
    case "max":
      return range.max;
    case "min":
      return range.min;
    default:
      return rule.value ?? 0;
  }
}

/** 单条规则是否命中 */
export function ruleHit(
  value: number,
  rule: ConditionalRule,
  range: ValueRange,
): boolean {
  const target = thresholdOf(rule, range);
  switch (rule.operator) {
    case "gt":
      return value > target;
    case "gte":
      return value >= target;
    case "lt":
      return value < target;
    case "lte":
      return value <= target;
    case "eq":
      return value === target;
    default:
      return false;
  }
}

export interface CellDecor {
  /** 单元格背景色 */
  background?: string;
  /** 文字颜色 */
  color?: string;
  bold?: boolean;
  /** 数据条：0-1 的填充比例 */
  bar?: { ratio: number; color: string };
  icon?: "up" | "flat" | "down";
  iconColor?: string;
}

/** 按条件格式计算单元格装饰（null 表示不装饰） */
export function cellDecor(
  value: CellValue,
  range: ValueRange | null,
  cfg: ConditionalFormat,
): CellDecor | null {
  if (!range || typeof value !== "number" || !Number.isFinite(value)) return null;
  const ratio = ratioOf(value, range);

  switch (cfg.mode) {
    case "dataBar":
      return { bar: { ratio, color: cfg.barColor } };
    case "colorScale":
      return { background: scaleColor(value, range, cfg) };
    case "iconSet": {
      // 按区间三等分：上三分之一 ▲、中三分之一 ■、下三分之一 ▼
      const icon = ratio >= 2 / 3 ? "up" : ratio >= 1 / 3 ? "flat" : "down";
      return { icon, iconColor: cfg.iconColor };
    }
    case "rules": {
      const hit = cfg.rules.find((r) => ruleHit(value, r, range));
      if (!hit) return null;
      return {
        background: hit.background || undefined,
        color: hit.color || undefined,
        bold: hit.bold || undefined,
      };
    }
    default:
      return null;
  }
}

/** 柱形图等图表着色：色阶按值取色，规则命中返回填充色 */
export function chartFill(
  value: CellValue,
  range: ValueRange | null,
  cfg: ConditionalFormat,
): string | undefined {
  if (!range || typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (cfg.mode === "colorScale") return scaleColor(value, range, cfg);
  if (cfg.mode === "rules") {
    const hit = cfg.rules.find((r) => ruleHit(value, r, range));
    return hit?.background || undefined;
  }
  return undefined;
}
