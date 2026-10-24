import type { ReactNode } from "react";
import type { ShapeKind } from "@bi/types";

/**
 * 形状清单：分组与顺序对齐 Power BI「插入 → 形状」下拉
 * （矩形 / 基本形状 / 箭头总汇）。
 */
export const SHAPE_GROUPS: Array<{
  label: string;
  items: Array<{ key: ShapeKind; label: string }>;
}> = [
  {
    label: "矩形",
    items: [
      { key: "rect", label: "矩形" },
      { key: "roundRect", label: "圆角矩形" },
      { key: "snipRect", label: "切角矩形" },
      { key: "diamond", label: "菱形" },
      { key: "parallelogram", label: "平行四边形" },
    ],
  },
  {
    label: "基本形状",
    items: [
      { key: "ellipse", label: "椭圆" },
      { key: "triangle", label: "三角形" },
      { key: "rightTriangle", label: "直角三角形" },
      { key: "trapezoid", label: "梯形" },
      { key: "pentagon", label: "五边形" },
      { key: "hexagon", label: "六边形" },
      { key: "octagon", label: "八边形" },
      { key: "heart", label: "心形" },
      { key: "cross", label: "十字形" },
      { key: "line", label: "线条" },
    ],
  },
  {
    label: "箭头总汇",
    items: [
      { key: "arrowLeftRight", label: "左右箭头" },
      { key: "arrowRight", label: "向右箭头" },
      { key: "arrowUp", label: "向上箭头" },
      { key: "arrowDown", label: "向下箭头" },
      { key: "bendArrow", label: "折线箭头" },
      { key: "chevron", label: "燕尾箭头" },
    ],
  },
];

/** 形状中文名（用于格式面板下拉与提示） */
export const SHAPE_LABELS = Object.fromEntries(
  SHAPE_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])),
) as Record<ShapeKind, string>;

/**
 * 各形状在 100×100 视图框内的路径；线条与箭头使用描边，
 * 其余为闭合路径（填充 + 描边），配合 preserveAspectRatio="none" 自适应尺寸。
 */
const PATHS: Record<ShapeKind, string> = {
  rect: "M0,0 H100 V100 H0 Z",
  roundRect:
    "M12,0 H88 A12,12 0 0 1 100,12 V88 A12,12 0 0 1 88,100 H12 A12,12 0 0 1 0,88 V12 A12,12 0 0 1 12,0 Z",
  snipRect: "M22,0 H100 V100 H0 V22 Z",
  diamond: "M50,0 L100,50 L50,100 L0,50 Z",
  parallelogram: "M28,0 H100 L72,100 H0 Z",
  ellipse: "M50,0 A50,50 0 0 1 50,100 A50,50 0 0 1 50,0 Z",
  triangle: "M50,0 L100,100 H0 Z",
  rightTriangle: "M0,0 L100,100 H0 Z",
  trapezoid: "M26,0 H74 L100,100 H0 Z",
  pentagon: "M50,0 L100,38 L81,100 H19 L0,38 Z",
  hexagon: "M25,0 H75 L100,50 L75,100 H25 L0,50 Z",
  octagon: "M30,0 H70 L100,30 V70 L70,100 H30 L0,70 V30 Z",
  heart:
    "M50,96 C12,66 0,48 0,31 C0,12 18,3 31,10 C41,16 47,24 50,31 C53,24 59,16 69,10 C82,3 100,12 100,31 C100,48 88,66 50,96 Z",
  cross: "M35,0 H65 V35 H100 V65 H65 V100 H35 V65 H0 V35 H35 Z",
  line: "M0,50 H100",
  arrowLeftRight: "M0,50 L26,18 V38 H74 V18 L100,50 L74,82 V62 H26 V82 Z",
  arrowRight: "M0,34 H58 V12 L100,50 L58,88 V66 H0 Z",
  arrowUp: "M34,100 V42 H12 L50,0 L88,42 H66 V100 Z",
  arrowDown: "M34,0 V58 H12 L50,100 L88,58 H66 V0 Z",
  bendArrow: "M0,100 V42 H58 V16 L100,46 L58,76 V60 H24 V100 Z",
  chevron: "M26,0 H58 L100,50 L58,100 H26 L68,50 Z",
};

/** 仅描边的形状（不填充内部） */
const STROKE_ONLY: ShapeKind[] = ["line"];

export interface ShapePathProps {
  /** 渲染尺寸类名，如 "h-4 w-4" */
  className?: string;
  /** 描边颜色（菜单图标用 currentColor 即可） */
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  /** 是否使用形状自身的填充（菜单图标里传 false 只画轮廓） */
  filled?: boolean;
}

/** 以 SVG 路径渲染某个形状（100×100 视图框，可自由拉伸） */
export function ShapePath({
  kind,
  className,
  stroke = "currentColor",
  strokeWidth = 1.5,
  fill = "transparent",
  filled = false,
}: ShapePathProps & { kind: ShapeKind }): ReactNode {
  const strokeOnly = STROKE_ONLY.includes(kind);
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d={PATHS[kind]}
        fill={strokeOnly || !filled ? "none" : fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
