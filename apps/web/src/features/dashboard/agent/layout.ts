// 生成规格的本地排布：服务端只给语义结构，坐标 / 尺寸在浏览器侧计算，
// 追加到已有画布下方，避免与现有视觉对象重叠。

import type { WidgetLayout } from "@bi/types";
import type { DashboardSpec, SpecSlicer } from "./types";

export const AGENT_MARGIN = 24;
export const AGENT_GAP = 24;
/** 页面默认宽度（与 DashboardView 的 DEFAULT_PAGE_W 一致） */
export const AGENT_PAGE_W = 1280;

export const AGENT_SLICER_SIZE = { w: 260, h: 200 };
/** 数据卡片：一行平铺，高度取常规卡片的一半 */
export const AGENT_KPI_SIZE = { w: 420, h: 70 };
export const AGENT_CHART_SIZE = { w: 600, h: 300 };

/**
 * 切片器高度按控件形态取值：下拉只有一个选择框，用矮卡片即可；
 * 列表 / 层次结构要展示候选值，保持较高；区间类需要两个输入框，取中间值。
 */
const SLICER_HEIGHTS: Record<string, number> = {
  dropdown: 96,
  before: 104,
  after: 104,
  between: 132,
  relativeDate: 104,
  list: AGENT_SLICER_SIZE.h,
  hierarchy: AGENT_SLICER_SIZE.h,
};

/** 单个切片器的推荐高度（未知类型按默认高度） */
export function slicerHeight(type?: SpecSlicer["type"] | string): number {
  return (type && SLICER_HEIGHTS[type]) || AGENT_SLICER_SIZE.h;
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpecLayout {
  slicers: Placement[];
  kpis: Placement[];
  charts: Placement[];
}

interface RowResult {
  placements: Placement[];
  nextY: number;
}

/** 按行铺排：每行放得下几个就放几个，超出换行 */
function placeRows(
  count: number,
  size: { w: number; h: number },
  startY: number,
  pageWidth: number,
): RowResult {
  return placeRowsWithHeights(
    Array.from({ length: count }, () => size.h),
    size.w,
    startY,
    pageWidth,
  );
}

/**
 * 按行铺排（每项高度可不同）：同一行取最高项作为行高，保证不重叠且整块尽量紧凑。
 */
function placeRowsWithHeights(
  heights: number[],
  width: number,
  startY: number,
  pageWidth: number,
): RowResult {
  const usable = pageWidth - AGENT_MARGIN * 2 + AGENT_GAP;
  const perRow = Math.max(1, Math.floor(usable / (width + AGENT_GAP)));
  const placements: Placement[] = [];
  let y = startY;
  for (let start = 0; start < heights.length; start += perRow) {
    const row = heights.slice(start, start + perRow);
    const rowH = Math.max(...row);
    row.forEach((h, col) => {
      placements.push({ x: AGENT_MARGIN + col * (width + AGENT_GAP), y, w: width, h });
    });
    y += rowH + AGENT_GAP;
  }
  return { placements, nextY: heights.length > 0 ? y : startY };
}

/** 数据卡片一行平铺：等宽铺满可用宽度，数量少时保持常规卡片宽度 */
function placeKpiRow(count: number, startY: number, pageWidth: number): RowResult {
  if (count === 0) return { placements: [], nextY: startY };
  const usable = pageWidth - AGENT_MARGIN * 2;
  const equal = Math.floor((usable - (count - 1) * AGENT_GAP) / count);
  const w = Math.min(AGENT_KPI_SIZE.w, equal);
  const placements = Array.from({ length: count }, (_, i) => ({
    x: AGENT_MARGIN + i * (w + AGENT_GAP),
    y: startY,
    w,
    h: AGENT_KPI_SIZE.h,
  }));
  return { placements, nextY: startY + AGENT_KPI_SIZE.h + AGENT_GAP };
}

/** 已有视觉对象的最下边缘；没有对象时从页边距开始 */
export function bottomOf(widgets: Array<{ layout: WidgetLayout }>): number {
  return widgets.reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0);
}

/**
 * 给生成规格算坐标：切片器 → 数据卡片 → 图表，自上而下依次排布。
 * 起点固定在已有内容的最下方留出一个间距。
 */
export function layoutSpec(
  spec: DashboardSpec,
  occupied: Array<{ layout: WidgetLayout }> = [],
  pageWidth: number = AGENT_PAGE_W,
): SpecLayout {
  const bottom = bottomOf(occupied);
  const startY = bottom > 0 ? bottom + AGENT_GAP : AGENT_MARGIN;

  const slicers = placeRowsWithHeights(
    spec.slicers.map((s) => slicerHeight(s.type)),
    AGENT_SLICER_SIZE.w,
    startY,
    pageWidth,
  );
  const kpis = placeKpiRow(spec.kpis.length, slicers.nextY, pageWidth);
  const charts = placeRows(spec.charts.length, AGENT_CHART_SIZE, kpis.nextY, pageWidth);

  return { slicers: slicers.placements, kpis: kpis.placements, charts: charts.placements };
}
