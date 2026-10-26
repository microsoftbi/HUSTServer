import type { AggregateFn, ChartType, Measure, WidgetEncoding } from "@bi/types";

export const CHART_COLORS = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#7c3aed",
  "#dc2626",
  "#0891b2",
  "#ca8a04",
  "#db2777",
];

export const AGG_LABELS: Record<AggregateFn, string> = {
  sum: "求和",
  count: "计数",
  avg: "平均",
  min: "最小",
  max: "最大",
  none: "原始值",
};

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: "簇状柱形图",
  stackedBar: "堆积柱形图",
  stackedBar100: "100% 堆积柱形图",
  horizontalBar: "条形图",
  horizontalStackedBar: "堆积条形图",
  line: "折线图",
  area: "面积图",
  stackedArea: "堆积面积图",
  combo: "折线与柱形图",
  pie: "饼图",
  donut: "环形图",
  scatter: "散点图",
  treemap: "树状图",
  decomposition: "分解树",
  funnel: "漏斗图",
  radialBar: "径向条形图",
  table: "表格",
  kpi: "数值卡",
  map: "填充地图",
  matrix: "数据透视表",
  filter: "切片器",
  text: "文本框",
  image: "图像",
  shape: "形状",
  button: "按钮",
};

/** 字段槽位名称（按图表类型对齐 Power BI 命名） */
export interface WellLabels {
  dimension: string;
  series: string;
  measures: string;
}

export function wellLabels(type: ChartType): WellLabels {
  switch (type) {
    case "pie":
    case "donut":
      return { dimension: "图例", series: "详细级别（可选）", measures: "值" };
    case "treemap":
    case "funnel":
    case "radialBar":
      return { dimension: "类别", series: "详细级别（可选）", measures: "值" };
    case "decomposition":
      return { dimension: "说明依据", series: "详细级别（可选）", measures: "分析" };
    case "table":
      return { dimension: "列", series: "详细级别（可选）", measures: "值" };
    case "kpi":
      return { dimension: "分类", series: "详细级别（可选）", measures: "值" };
    case "map":
      return { dimension: "位置", series: "图例（可选）", measures: "值" };
    case "matrix":
      return { dimension: "行", series: "列", measures: "值" };
    default:
      return { dimension: "X 轴", series: "图例（可选）", measures: "Y 轴" };
  }
}

export function measureLabel(m: Measure): string {
  return `${AGG_LABELS[m.agg]}(${m.field})`;
}

/**
 * Power BI 风格的自动标题：由字段槽位生成，如「求和(销售额) 按 地区」。
 * 视觉对象未自定义标题时使用，避免直接暴露数据源名称。
 */
export function autoTitle(encoding: WidgetEncoding): string {
  const measures = encoding.measures.map(measureLabel).join("、");
  if (encoding.dimension) {
    return measures ? `${measures} 按 ${encoding.dimension}` : encoding.dimension;
  }
  return measures;
}

export function colorAt(i: number): string {
  return activePalette[i % activePalette.length];
}

/**
 * 当前配色：默认使用内置调色板，导入主题后替换为主题的 dataColors。
 * 以模块级变量承载，避免把调色板逐层透传给所有图表组件。
 */
let activePalette: string[] = CHART_COLORS;

/** 设置全局配色；传空则恢复默认调色板。 */
export function setChartPalette(colors: string[] | null | undefined): void {
  activePalette = colors && colors.length > 0 ? colors : CHART_COLORS;
}

/**
 * 将每一行的度量值按其行内合计归一化为百分比（用于 100% 堆积图）。
 * 非数值或缺失值按 0 处理；行内合计为 0 时该行全部记为 0，避免除零。
 */
export function normalizeToPercent(
  data: Array<Record<string, string | number | null>>,
  keys: string[],
): Array<Record<string, string | number | null>> {
  return data.map((row) => {
    const total = keys.reduce((acc, k) => {
      const v = row[k];
      return acc + (typeof v === "number" ? v : 0);
    }, 0);
    const next: Record<string, string | number | null> = { ...row };
    for (const k of keys) {
      const v = row[k];
      const n = typeof v === "number" ? v : 0;
      next[k] = total === 0 ? 0 : (n / total) * 100;
    }
    return next;
  });
}
