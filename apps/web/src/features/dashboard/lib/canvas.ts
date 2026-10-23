// 报表画布的纯函数库：自由像素定位所需的吸附（对齐辅助线）与缩放计算。
// 均为无副作用函数，便于单测；拖拽交互逻辑由 ReportCanvas 负责。

import type { WidgetLayout } from "@bi/types";

/** 吸附阈值（像素）：移动/缩放边与候选线的距离在此范围内即吸附 */
export const SNAP_THRESHOLD = 6;

/** 视觉对象最小尺寸（像素），对齐 Power BI 的可用下限 */
export const MIN_WIDGET_W = 160;
export const MIN_WIDGET_H = 100;

export interface SizeLimit {
  w: number;
  h: number;
}

/** 普通图表的最小尺寸 */
export const MIN_WIDGET_SIZE: SizeLimit = { w: MIN_WIDGET_W, h: MIN_WIDGET_H };
/** 切片器允许缩到 20×20（小尺寸切片器只显示图标） */
export const MIN_FILTER_SIZE: SizeLimit = { w: 20, h: 20 };

export type Rect = WidgetLayout;

/** 8 个缩放方向：n/s/e/w 为边，ne/nw/se/sw 为角 */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface SnapResult {
  /** 吸附后的矩形 */
  rect: Rect;
  /** 命中的垂直辅助线 x 坐标 */
  vLines: number[];
  /** 命中的水平辅助线 y 坐标 */
  hLines: number[];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 收集某一轴上的候选对齐线：页面（起/中/止）+ 其它视觉对象的边与中线 */
function lineCandidates(
  others: Rect[],
  axis: "x" | "y",
  pageW: number,
  pageH: number,
): number[] {
  const page = axis === "x" ? pageW : pageH;
  const lines = [0, page / 2, page];
  for (const o of others) {
    if (axis === "x") {
      lines.push(o.x, o.x + o.w / 2, o.x + o.w);
    } else {
      lines.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
  }
  return lines;
}

/**
 * 在单轴上为一组「移动边」寻找最近的候选线。
 * @returns 需要施加的位移 delta，以及吸附后与候选线重合的辅助线坐标
 */
function snapAxis(
  edges: number[],
  candidates: number[],
): { delta: number; lines: number[] } {
  let delta = 0;
  let bestDist = Infinity;
  for (const e of edges) {
    for (const c of candidates) {
      const d = c - e;
      const dist = Math.abs(d);
      if (dist <= SNAP_THRESHOLD && dist < bestDist) {
        bestDist = dist;
        delta = d;
      }
    }
  }
  if (bestDist === Infinity) return { delta: 0, lines: [] };

  const lines: number[] = [];
  for (const e of edges) {
    for (const c of candidates) {
      if (Math.abs(c - (e + delta)) < 0.5 && !lines.includes(c)) lines.push(c);
    }
  }
  return { delta, lines };
}

/** 拖动：对齐左/中/右、上/中/下 */
export function snapMove(
  rect: Rect,
  others: Rect[],
  pageW: number,
  pageH: number,
): SnapResult {
  const vEdges = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const hEdges = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  const v = snapAxis(vEdges, lineCandidates(others, "x", pageW, pageH));
  const h = snapAxis(hEdges, lineCandidates(others, "y", pageW, pageH));
  return {
    rect: { x: rect.x + v.delta, y: rect.y + h.delta, w: rect.w, h: rect.h },
    vLines: v.lines,
    hLines: h.lines,
  };
}

/** 缩放：按方向调整尺寸，保持最小尺寸；w/n 方向同步移动左上角 */
export function resizeRect(
  rect: Rect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  min: SizeLimit = MIN_WIDGET_SIZE,
): Rect {
  let { x, y, w, h } = rect;
  const right = x + w;
  const bottom = y + h;

  if (dir.includes("e")) w = Math.max(min.w, w + dx);
  if (dir.includes("s")) h = Math.max(min.h, h + dy);
  if (dir.includes("w")) {
    w = Math.max(min.w, w - dx);
    x = right - w;
  }
  if (dir.includes("n")) {
    h = Math.max(min.h, h - dy);
    y = bottom - h;
  }
  return { x, y, w, h };
}

/** 缩放吸附：仅对正在移动的边做吸附（e/w 影响横轴，n/s 影响纵轴） */
export function snapResize(
  rect: Rect,
  dir: ResizeDir,
  others: Rect[],
  pageW: number,
  pageH: number,
  min: SizeLimit = MIN_WIDGET_SIZE,
): SnapResult {
  const result: Rect = { ...rect };
  const vLines: number[] = [];
  const hLines: number[] = [];

  if (dir.includes("e") || dir.includes("w")) {
    const candidates = lineCandidates(others, "x", pageW, pageH);
    const edge = dir.includes("e") ? result.x + result.w : result.x;
    const { delta, lines } = snapAxis([edge], candidates);
    if (dir.includes("e")) {
      if (result.w + delta >= min.w) {
        result.w += delta;
        vLines.push(...lines);
      }
    } else if (result.w - delta >= min.w) {
      result.x += delta;
      result.w -= delta;
      vLines.push(...lines);
    }
  }

  if (dir.includes("n") || dir.includes("s")) {
    const candidates = lineCandidates(others, "y", pageW, pageH);
    const edge = dir.includes("s") ? result.y + result.h : result.y;
    const { delta, lines } = snapAxis([edge], candidates);
    if (dir.includes("s")) {
      if (result.h + delta >= min.h) {
        result.h += delta;
        hLines.push(...lines);
      }
    } else if (result.h - delta >= min.h) {
      result.y += delta;
      result.h -= delta;
      hLines.push(...lines);
    }
  }

  return { rect: result, vLines, hLines };
}

/** 将矩形夹紧到页面范围内，并保证不小于最小尺寸 */
export function clampRect(
  rect: Rect,
  pageW: number,
  pageH: number,
  min: SizeLimit = MIN_WIDGET_SIZE,
): Rect {
  const w = clamp(rect.w, min.w, Math.max(min.w, pageW));
  const h = clamp(rect.h, min.h, Math.max(min.h, pageH));
  const x = clamp(rect.x, 0, Math.max(0, pageW - w));
  const y = clamp(rect.y, 0, Math.max(0, pageH - h));
  return { x, y, w, h };
}

/** 对齐与分布模式（对齐 Power BI 的「格式 → 对齐」工具条） */
export type AlignMode =
  | "left"
  | "hcenter"
  | "right"
  | "top"
  | "vcenter"
  | "bottom"
  | "distributeH"
  | "distributeV"
  | "matchW"
  | "matchH";

/**
 * 多选对齐 / 分布。
 * 对齐以外接矩形为基准（与 Power BI 一致：左对齐贴最左边缘）；
 * 等宽 / 等高以第一个矩形为基准。返回顺序与入参一致。
 */
export function alignRects(rects: Rect[], mode: AlignMode): Rect[] {
  if (rects.length < 2) return rects.map((r) => ({ ...r }));
  const out = rects.map((r) => ({ ...r }));
  const minX = Math.min(...out.map((r) => r.x));
  const maxX = Math.max(...out.map((r) => r.x + r.w));
  const minY = Math.min(...out.map((r) => r.y));
  const maxY = Math.max(...out.map((r) => r.y + r.h));

  switch (mode) {
    case "left":
      for (const r of out) r.x = minX;
      break;
    case "right":
      for (const r of out) r.x = maxX - r.w;
      break;
    case "hcenter": {
      const center = (minX + maxX) / 2;
      for (const r of out) r.x = center - r.w / 2;
      break;
    }
    case "top":
      for (const r of out) r.y = minY;
      break;
    case "bottom":
      for (const r of out) r.y = maxY - r.h;
      break;
    case "vcenter": {
      const center = (minY + maxY) / 2;
      for (const r of out) r.y = center - r.h / 2;
      break;
    }
    case "distributeH": {
      const sorted = [...out].sort((a, b) => a.x - b.x);
      const total = sorted.reduce((s, r) => s + r.w, 0);
      const gap = (maxX - minX - total) / (sorted.length - 1);
      let cursor = minX;
      for (const r of sorted) {
        r.x = cursor;
        cursor += r.w + gap;
      }
      break;
    }
    case "distributeV": {
      const sorted = [...out].sort((a, b) => a.y - b.y);
      const total = sorted.reduce((s, r) => s + r.h, 0);
      const gap = (maxY - minY - total) / (sorted.length - 1);
      let cursor = minY;
      for (const r of sorted) {
        r.y = cursor;
        cursor += r.h + gap;
      }
      break;
    }
    case "matchW": {
      const w = out[0].w;
      for (const r of out) r.w = w;
      break;
    }
    case "matchH": {
      const h = out[0].h;
      for (const r of out) r.h = h;
      break;
    }
  }
  return out;
}
