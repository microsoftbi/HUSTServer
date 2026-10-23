// 视觉对象通用外观与报表页设置的默认值与样式换算（对齐 Power BI 的格式窗格）。

import type { CSSProperties } from "react";
import type {
  ChartWidget,
  Dashboard,
  PageConfig,
  WidgetShadow,
  WidgetStyle,
} from "../types";

export const DEFAULT_WIDGET_STYLE: WidgetStyle = {
  background: "",
  backgroundOpacity: 100,
  borderColor: "#e2e8f0",
  borderWidth: 1,
  borderRadius: 6,
  padding: 8,
  shadow: "sm",
  titleFontSize: 12,
  titleColor: "#4b5563",
  titleAlign: "left",
};

export const SHADOW_CSS: Record<WidgetShadow, string> = {
  none: "none",
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
};

/** 合并用户配置与默认值 */
export function styleOf(widget: ChartWidget): WidgetStyle {
  return { ...DEFAULT_WIDGET_STYLE, ...widget.style };
}

/** 把 #rrggbb 与不透明度换算为 rgba()；非十六进制颜色原样返回 */
export function withAlpha(color: string, opacity: number): string {
  if (!color) return "transparent";
  const hex = color.trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return hex;
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  const a = Math.min(100, Math.max(0, opacity)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 视觉对象外框的内联样式（背景 / 边框 / 圆角 / 阴影） */
export function boxStyleOf(widget: ChartWidget): CSSProperties {
  const s = styleOf(widget);
  return {
    borderRadius: s.borderRadius,
    borderStyle: "solid",
    borderWidth: s.borderWidth,
    borderColor: s.borderColor,
    background: s.background ? withAlpha(s.background, s.backgroundOpacity) : undefined,
    boxShadow: SHADOW_CSS[s.shadow],
  };
}

export const DEFAULT_PAGE: PageConfig = {
  width: 0,
  height: 0,
  background: "#ffffff",
  backgroundImage: "",
  wallpaper: "",
};

export function pageOf(dashboard: Dashboard | undefined): PageConfig {
  return { ...DEFAULT_PAGE, ...dashboard?.page };
}

/** Power BI 常见画布比例预设 */
export interface PagePreset {
  key: string;
  label: string;
  width: number;
  height: number;
}

export const PAGE_PRESETS: PagePreset[] = [
  { key: "fit", label: "适应容器宽度", width: 0, height: 0 },
  { key: "16:9", label: "16:9（1280 × 720）", width: 1280, height: 720 },
  { key: "4:3", label: "4:3（960 × 720）", width: 960, height: 720 },
  { key: "16:10", label: "16:10（1280 × 800）", width: 1280, height: 800 },
];

/** 根据当前宽高反查预设，找不到则为自定义 */
export function matchPreset(page: PageConfig): string {
  const hit = PAGE_PRESETS.find(
    (p) => p.width === page.width && p.height === page.height,
  );
  return hit ? hit.key : "custom";
}
