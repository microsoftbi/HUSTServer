// 装饰元素（文本框 / 图像 / 形状 / 按钮）的默认值与读取工具。
// 装饰元素不绑定数据集，只承载排版与视觉内容，与 Power BI 的「插入 → 文本框 / 按钮 / 形状 / 图像」对齐。

import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CircleHelp,
  CornerUpLeft,
  Eraser,
  Info,
  LayoutGrid,
  MessageCircleQuestion,
  RotateCcw,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import type { ButtonAction, ChartType, ChartWidget, DecorationConfig, ShapeKind } from "../types";

/** 属于装饰元素的视觉对象类型 */
export const DECOR_TYPES: ChartType[] = ["text", "button", "shape", "image"];

export function isDecoration(type: ChartType): boolean {
  return type === "text" || type === "button" || type === "shape" || type === "image";
}

export const DEFAULT_DECORATION: DecorationConfig = {
  text: "",
  action: "blank",
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

/** 按类型给出更贴合的初始配置；按钮可指定动作，形状可指定种类 */
export function defaultDecoration(
  type: ChartType,
  action: ButtonAction = "blank",
  shape: ShapeKind = "rect",
): DecorationConfig {
  if (type === "text") {
    return { ...DEFAULT_DECORATION, text: "双击编辑文本" };
  }
  if (type === "button") {
    // 按钮默认蓝底白字，双击可直接改文案（对齐 Power BI 插入按钮的默认外观）
    return {
      ...DEFAULT_DECORATION,
      text: BUTTON_LABELS[action],
      action,
      fontSize: 14,
      bold: false,
      color: "#ffffff",
      fill: "#2563eb",
      stroke: "#1d4ed8",
      align: "center",
    };
  }
  return { ...DEFAULT_DECORATION, shape };
}

/**
 * 按钮动作清单：顺序与 Power BI「插入 → 按钮」下拉一致
 * （向左键 / 右箭头 / 重置 / 上一步 / 信息 / 帮助 / 问答 / 书签 / 空白 / 应用所有切片器 / 清除所有切片器 / 导航器）
 */
export const BUTTON_ACTIONS: Array<{
  key: ButtonAction;
  label: string;
  Icon: typeof ArrowLeft;
}> = [
  { key: "back", label: "向左键", Icon: ArrowLeft },
  { key: "next", label: "右箭头", Icon: ArrowRight },
  { key: "reset", label: "重置", Icon: RotateCcw },
  { key: "stepBack", label: "上一步", Icon: CornerUpLeft },
  { key: "info", label: "信息", Icon: Info },
  { key: "help", label: "帮助", Icon: CircleHelp },
  { key: "qa", label: "问答", Icon: MessageCircleQuestion },
  { key: "bookmark", label: "书签", Icon: Bookmark },
  { key: "blank", label: "空白", Icon: Square },
  { key: "applySlicers", label: "应用所有切片器", Icon: SlidersHorizontal },
  { key: "clearSlicers", label: "清除所有切片器", Icon: Eraser },
  { key: "navigator", label: "导航器", Icon: LayoutGrid },
];

/** 按钮动作的中文名称（同时作为按钮默认文案） */
export const BUTTON_LABELS = Object.fromEntries(
  BUTTON_ACTIONS.map((a) => [a.key, a.label]),
) as Record<ButtonAction, string>;

/** 按钮动作对应的图标 */
export const BUTTON_ICONS = Object.fromEntries(
  BUTTON_ACTIONS.map((a) => [a.key, a.Icon]),
) as Record<ButtonAction, typeof ArrowLeft>;

/** 合并用户配置与默认值，兼容旧数据 */
export function decorationOf(widget: ChartWidget): DecorationConfig {
  return { ...DEFAULT_DECORATION, ...widget.decoration };
}
