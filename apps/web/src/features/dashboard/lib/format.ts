import type { CellValue, FieldFormat, NumberUnit } from "@bi/types";

/** 字段未配置格式时，数值按自动精度显示 */
export const DEFAULT_FIELD_FORMAT: FieldFormat = {
  decimals: -1,
  thousands: false,
  unit: "none",
};

export const DECIMAL_OPTIONS = [
  { value: "-1", label: "自动" },
  { value: "0", label: "0" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "6", label: "6" },
];

export const UNIT_OPTIONS: Array<{ value: NumberUnit; label: string }> = [
  { value: "none", label: "无" },
  { value: "thousand", label: "千" },
  { value: "tenThousand", label: "万" },
  { value: "million", label: "百万" },
  { value: "hundredMillion", label: "亿" },
];

const UNIT_DIVISOR: Record<NumberUnit, number> = {
  none: 1,
  thousand: 1e3,
  tenThousand: 1e4,
  million: 1e6,
  hundredMillion: 1e8,
};

const UNIT_SUFFIX: Record<NumberUnit, string> = {
  none: "",
  thousand: "千",
  tenThousand: "万",
  million: "百万",
  hundredMillion: "亿",
};

/** 仅对整数部分加千分位，保留符号与小数部分 */
function groupThousands(text: string): string {
  const [intPart, frac] = text.split(".");
  const negative = intPart.startsWith("-");
  const digits = negative ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? "-" : "";
  return frac === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${frac}`;
}

/**
 * 按字段级格式渲染数值。
 * - decimals < 0：自动精度（整数原样，小数最多 6 位并去掉浮点尾差）
 * - unit：先按单位折算，再拼后缀（千 / 万 / 百万 / 亿）
 */
export function formatNumber(value: number, format?: FieldFormat | null): string {
  if (!format) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  const scaled = (format.percent ? value * 100 : value) / UNIT_DIVISOR[format.unit];
  // 百分比默认保留 2 位（“自动”精度下 0.12345 会显示成 12.345% 太长）
  const decimals = format.percent && format.decimals < 0 ? 2 : format.decimals;
  let text: string;
  if (decimals < 0) {
    text = Number.isInteger(scaled) ? String(scaled) : String(Number(scaled.toFixed(6)));
  } else {
    text = scaled.toFixed(decimals);
  }
  if (format.thousands) text = groupThousands(text);
  return `${text}${UNIT_SUFFIX[format.unit]}${format.percent ? "%" : ""}`;
}

/** 表格/预览展示用的格式化 */
export function formatCell(value: CellValue, format?: FieldFormat | null): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return formatNumber(value, format);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
