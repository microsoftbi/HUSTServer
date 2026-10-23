// 装饰元素（文本框 / 图像 / 形状）的默认值与读取工具。
// 装饰元素不绑定数据集，只承载排版与视觉内容，与 Power BI 的「插入 → 文本框 / 图像 / 形状」对齐。

import type { ChartType, ChartWidget, DecorationConfig } from "../types";

/** 属于装饰元素的视觉对象类型 */
export const DECOR_TYPES: ChartType[] = ["text", "image", "shape"];

export function isDecoration(type: ChartType): boolean {
  return type === "text" || type === "image" || type === "shape";
}

export const DEFAULT_DECORATION: DecorationConfig = {
  text: "",
  fontSize: 18,
  bold: true,
  color: "#1f2937",
  align: "left",
  verticalAlign: "middle",
  imageUrl: "",
  imageFit: "contain",
  shape: "rect",
  fill: "#dbeafe",
  stroke: "#2563eb",
  strokeWidth: 1,
  radius: 6,
};

/** 按类型给出更贴合的初始配置 */
export function defaultDecoration(type: ChartType): DecorationConfig {
  if (type === "text") {
    return { ...DEFAULT_DECORATION, text: "双击编辑文本" };
  }
  if (type === "image") {
    return { ...DEFAULT_DECORATION };
  }
  return { ...DEFAULT_DECORATION };
}

/** 合并用户配置与默认值，兼容旧数据 */
export function decorationOf(widget: ChartWidget): DecorationConfig {
  return { ...DEFAULT_DECORATION, ...widget.decoration };
}
