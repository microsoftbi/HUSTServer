// 树状图（Treemap）的纯函数库：两层数据构建、squarified 布局、配色与标签适配。
// 均为无副作用函数，便于单测；渲染与交互由 TreemapChart 负责。

import type {
  CellValue,
  ChartWidget,
  Dataset,
  TreemapColorMode,
  TreemapConfig,
  WidgetEncoding,
} from "@bi/types";
import { applyAgg, measureKey, normalizeLabel } from "./aggregate";
import { CHART_COLORS } from "./chart";

/** 参与布局的最大图块数，超出时丢弃值最小的叶子，避免成百上千个矩形拖慢渲染 */
export const MAX_TILES = 200;

export interface TreemapLeaf {
  /** 叶子标签：有详细级别时为明细值，否则等于分类名 */
  name: string;
  /** 所属分类（顶层分组） */
  category: string;
  value: number;
}

export interface TreemapGroup {
  name: string;
  value: number;
  leaves: TreemapLeaf[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile<T> {
  item: T;
  rect: Box;
}

/** Power BI 树状图的默认外观 */
export function defaultTreemap(): TreemapConfig {
  return {
    colorMode: "category",
    baseColor: CHART_COLORS[0],
    showCategoryLabels: true,
    showValueLabels: true,
    labelColor: "#ffffff",
    labelFontSize: 12,
    showBorder: true,
    groupPadding: 2,
  };
}

/** 读取树状图配置：旧仪表板没有该字段时回落到默认值 */
export function treemapOf(widget: ChartWidget): TreemapConfig {
  return { ...defaultTreemap(), ...(widget.treemap ?? {}) };
}

/**
 * 按「类别 → 详细信息」两级聚合数据集。
 * - 无详细级别字段时每个类别只有一个叶子；
 * - 无类别字段时整体作为单个分组（用度量名作标题）；
 * - 与 Power BI 一致：非正值（0/负数）不参与布局，直接丢弃。
 */
export function buildTreemapGroups(
  dataset: Dataset,
  encoding: WidgetEncoding,
): TreemapGroup[] {
  const measure = encoding.measures[0];
  if (!measure) return [];

  const measureIdx = dataset.columns.findIndex((c) => c.name === measure.field);
  if (measureIdx < 0) return [];

  const dimIdx = encoding.dimension
    ? dataset.columns.findIndex((c) => c.name === encoding.dimension)
    : -1;
  const detailIdx = encoding.series
    ? dataset.columns.findIndex((c) => c.name === encoding.series)
    : -1;

  const fallbackName = measureKey(measure);

  // 分类 → 明细 → 该明细下的度量原始值
  const buckets = new Map<string, Map<string, CellValue[]>>();
  for (const row of dataset.rows) {
    const category = dimIdx >= 0 ? normalizeLabel(row[dimIdx]) : "__all__";
    let leaves = buckets.get(category);
    if (!leaves) {
      leaves = new Map();
      buckets.set(category, leaves);
    }
    const detail = detailIdx >= 0 ? normalizeLabel(row[detailIdx]) : "__all__";
    let cells = leaves.get(detail);
    if (!cells) {
      cells = [];
      leaves.set(detail, cells);
    }
    cells.push(row[measureIdx]);
  }

  const groups: TreemapGroup[] = [];
  for (const [category, leaves] of buckets) {
    const name = dimIdx >= 0 ? category : fallbackName;
    const items: TreemapLeaf[] = [];
    for (const [detail, cells] of leaves) {
      const aggregated = applyAgg(cells, measure.agg);
      const value = typeof aggregated === "number" && aggregated > 0 ? aggregated : 0;
      if (value <= 0) continue;
      items.push({
        name: detailIdx >= 0 ? detail : name,
        category: name,
        value,
      });
    }
    if (items.length === 0) continue;
    items.sort((a, b) => b.value - a.value);
    groups.push({
      name,
      value: items.reduce((sum, item) => sum + item.value, 0),
      leaves: items,
    });
  }

  groups.sort((a, b) => b.value - a.value);
  return capLeaves(groups);
}

/** 只保留值最大的若干个叶子（整体裁剪，保持分组与降序） */
export function capLeaves(groups: TreemapGroup[], limit = MAX_TILES): TreemapGroup[] {
  const total = groups.reduce((n, g) => n + g.leaves.length, 0);
  if (total <= limit) return groups;

  const top = groups
    .flatMap((g) => g.leaves)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
  const kept = new Set(top);

  const result: TreemapGroup[] = [];
  for (const group of groups) {
    const leaves = group.leaves.filter((leaf) => kept.has(leaf));
    if (leaves.length === 0) continue;
    result.push({
      name: group.name,
      value: leaves.reduce((sum, leaf) => sum + leaf.value, 0),
      leaves,
    });
  }
  result.sort((a, b) => b.value - a.value);
  return result;
}

/** 一行/一列图块的最差宽高比（squarified 算法用于决定何时换行） */
function worstRatio(areas: number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const area of areas) {
    sum += area;
    if (area > max) max = area;
    if (area < min) min = area;
  }
  if (sum <= 0 || min <= 0 || side <= 0) return Infinity;
  const side2 = side * side;
  return Math.max((side2 * max) / (sum * sum), (sum * sum) / (side2 * min));
}

/**
 * Squarified 树状图布局（与 Power BI 一致）：按值降序，贪心组成一行，
 * 当最差宽高比不再改善时换行，使矩形尽量接近正方形。
 * 返回值按输入顺序（已降序）排列，面积为矩形区域的等比例切分。
 */
export function squarify<T extends { value: number }>(
  items: T[],
  box: Box,
): Array<Tile<T>> {
  const remainingAll = items
    .filter((item) => item.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value);
  const out: Array<Tile<T>> = [];
  if (box.w <= 0 || box.h <= 0 || remainingAll.length === 0) return out;

  let rect = { ...box };
  let remaining = remainingAll;

  while (remaining.length > 0) {
    if (remaining.length === 1) {
      out.push({ item: remaining[0], rect: { ...rect } });
      break;
    }

    const total = remaining.reduce((sum, item) => sum + item.value, 0);
    if (total <= 0) break;
    const scale = (rect.w * rect.h) / total;
    const areas = remaining.map((item) => item.value * scale);
    const side = Math.min(rect.w, rect.h);

    // 贪心扩展当前行：加入下一项会让最差宽高比变差时停止
    let count = 1;
    let rowAreas = [areas[0]];
    while (count < remaining.length) {
      const candidate = [...rowAreas, areas[count]];
      if (worstRatio(candidate, side) > worstRatio(rowAreas, side)) break;
      rowAreas = candidate;
      count += 1;
    }

    const rowItems = remaining.slice(0, count);
    const rowArea = rowAreas.reduce((sum, area) => sum + area, 0);

    if (rect.w >= rect.h) {
      // 左列：宽度由行面积决定，行内图块自上而下按面积分配高度
      const colW = Math.min(rect.w, rowArea / rect.h);
      let y = rect.y;
      rowItems.forEach((item, index) => {
        const h =
          index === rowItems.length - 1
            ? rect.y + rect.h - y
            : (rowAreas[index] / rowArea) * rect.h;
        out.push({ item, rect: { x: rect.x, y, w: colW, h } });
        y += h;
      });
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      // 顶部横条：高度由行面积决定，行内图块自左向右按面积分配宽度
      const rowH = Math.min(rect.h, rowArea / rect.w);
      let x = rect.x;
      rowItems.forEach((item, index) => {
        const w =
          index === rowItems.length - 1
            ? rect.x + rect.w - x
            : (rowAreas[index] / rowArea) * rect.w;
        out.push({ item, rect: { x, y: rect.y, w, h: rowH } });
        x += w;
      });
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }

    remaining = remaining.slice(count);
  }

  return out;
}

/** 颜色混合：把 a 向 b 靠拢 t（0~1），用于生成同色系的深浅变化 */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const raw =
      m[1].length === 3
        ? m[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : m[1];
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  };

  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return a;
  const ratio = Math.min(1, Math.max(0, t));
  const channel = (i: number) =>
    Math.round(ca[i] + (cb[i] - ca[i]) * ratio)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** 调亮：向白色混合 */
export function lighten(color: string, amount: number): string {
  return mixHex(color, "#ffffff", amount);
}

/** 按类别（或详细信息）取主题色 */
export function categoryColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** 按值渐变：值越大越接近基础色，值越小越浅 */
export function valueColor(
  value: number,
  maxValue: number,
  baseColor: string,
  mode: TreemapColorMode = "value",
): string {
  if (mode === "single") return baseColor;
  if (mode === "category") {
    // 分类模式下由调用方传入序号；此函数仅处理渐变
    return baseColor;
  }
  const ratio = maxValue > 0 ? Math.min(1, Math.max(0, value / maxValue)) : 1;
  return mixHex(baseColor, "#ffffff", (1 - ratio) * 0.55);
}

/** 估算文本宽度（中文按 1 个字宽、其余按 0.55 个字宽） */
export function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

/** 空间不足时缩小字号（不低于 minFontSize） */
export function fitFontSize(
  text: string,
  maxWidth: number,
  maxFontSize: number,
  minFontSize = 8,
): number {
  if (maxWidth <= 0) return minFontSize;
  let size = Math.round(maxFontSize);
  while (size > minFontSize && textWidth(text, size) > maxWidth) size -= 1;
  return Math.max(minFontSize, size);
}

/** 超宽时按字符截断并追加省略号（与 Power BI 的标签截断一致） */
export function fitLabel(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0 || fontSize <= 0) return "";
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  let visible = "";
  for (const ch of text) {
    if (textWidth(visible + ch + ellipsis, fontSize) > maxWidth) break;
    visible += ch;
  }
  return visible ? visible + ellipsis : "";
}
