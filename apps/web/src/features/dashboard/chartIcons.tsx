import type { ReactElement, ReactNode } from "react";
import type { ChartType } from "@bi/types";

export interface ChartIconProps {
  className?: string;
}

/** Power BI 默认主题调色板（用于视觉对象图标着色） */
const C = {
  blue: "#118DFF",
  navy: "#12239E",
  orange: "#E66C37",
  pink: "#E044A7",
  violet: "#744EC2",
  yellow: "#D9B300",
  gray: "#8A8886",
};

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * 可视化类型图标：Power BI 风格的自绘彩色 SVG。
 * 顺序即画廊中的展示顺序。
 */
export const CHART_ICONS: Record<
  ChartType,
  (props: ChartIconProps) => ReactElement
> = {
  // 簇状柱形图
  bar: (p) => (
    <Svg {...p}>
      <rect x="4" y="13" width="4" height="8" rx="0.7" fill={C.blue} />
      <rect x="10" y="8" width="4" height="13" rx="0.7" fill={C.orange} />
      <rect x="16" y="4" width="4" height="17" rx="0.7" fill={C.yellow} />
    </Svg>
  ),

  // 堆积柱形图
  stackedBar: (p) => (
    <Svg {...p}>
      <rect x="4" y="14" width="4" height="6" fill={C.blue} />
      <rect x="4" y="11" width="4" height="3" fill={C.orange} />
      <rect x="4" y="8" width="4" height="3" fill={C.yellow} />
      <rect x="10" y="14" width="4" height="6" fill={C.blue} />
      <rect x="10" y="10" width="4" height="4" fill={C.orange} />
      <rect x="10" y="6" width="4" height="4" fill={C.yellow} />
      <rect x="16" y="14" width="4" height="6" fill={C.blue} />
      <rect x="16" y="9" width="4" height="5" fill={C.orange} />
      <rect x="16" y="4" width="4" height="5" fill={C.yellow} />
    </Svg>
  ),

  // 100% 堆积柱形图（各柱等高）
  stackedBar100: (p) => (
    <Svg {...p}>
      <rect x="4" y="13" width="4" height="7" fill={C.blue} />
      <rect x="4" y="8" width="4" height="5" fill={C.orange} />
      <rect x="4" y="4" width="4" height="4" fill={C.yellow} />
      <rect x="10" y="13" width="4" height="7" fill={C.blue} />
      <rect x="10" y="8" width="4" height="5" fill={C.orange} />
      <rect x="10" y="4" width="4" height="4" fill={C.yellow} />
      <rect x="16" y="13" width="4" height="7" fill={C.blue} />
      <rect x="16" y="8" width="4" height="5" fill={C.orange} />
      <rect x="16" y="4" width="4" height="4" fill={C.yellow} />
    </Svg>
  ),

  // 条形图（横向）
  horizontalBar: (p) => (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="4" rx="0.7" fill={C.blue} />
      <rect x="3" y="10" width="13" height="4" rx="0.7" fill={C.orange} />
      <rect x="3" y="15" width="8" height="4" rx="0.7" fill={C.yellow} />
    </Svg>
  ),

  // 堆积条形图（横向堆积）
  horizontalStackedBar: (p) => (
    <Svg {...p}>
      <rect x="3" y="5" width="8" height="4" fill={C.blue} />
      <rect x="11" y="5" width="6" height="4" fill={C.orange} />
      <rect x="17" y="5" width="4" height="4" fill={C.yellow} />
      <rect x="3" y="10" width="6" height="4" fill={C.blue} />
      <rect x="9" y="10" width="7" height="4" fill={C.orange} />
      <rect x="16" y="10" width="5" height="4" fill={C.yellow} />
      <rect x="3" y="15" width="5" height="4" fill={C.blue} />
      <rect x="8" y="15" width="5" height="4" fill={C.orange} />
      <rect x="13" y="15" width="8" height="4" fill={C.yellow} />
    </Svg>
  ),

  // 折线图
  line: (p) => (
    <Svg {...p}>
      <path
        d="M4 3 V20 H21"
        fill="none"
        stroke={C.gray}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <polyline
        points="4,15 9,9 14,12 20,5"
        fill="none"
        stroke={C.blue}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),

  // 面积图
  area: (p) => (
    <Svg {...p}>
      <path
        d="M4 3 V20 H21"
        fill="none"
        stroke={C.gray}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M4 15 L9 9 L14 12 L20 5 V20 H4 Z" fill={C.blue} fillOpacity="0.3" />
      <path
        d="M4 15 L9 9 L14 12 L20 5"
        fill="none"
        stroke={C.blue}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),

  // 堆积面积图
  stackedArea: (p) => (
    <Svg {...p}>
      <path d="M4 17 L9 12 L14 14 L20 10 V20 H4 Z" fill={C.blue} fillOpacity="0.45" />
      <path
        d="M4 11 L9 6 L14 8 L20 4 V10 L14 14 L9 12 Z"
        fill={C.orange}
        fillOpacity="0.5"
      />
    </Svg>
  ),

  // 折线与柱形图
  combo: (p) => (
    <Svg {...p}>
      <path
        d="M4 3 V20 H21"
        fill="none"
        stroke={C.gray}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <rect x="6" y="12" width="4" height="8" rx="0.6" fill={C.blue} />
      <rect x="13" y="15" width="4" height="5" rx="0.6" fill={C.orange} />
      <polyline
        points="4,14 10,7 16,10 21,4"
        fill="none"
        stroke={C.yellow}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),

  // 饼图
  pie: (p) => (
    <Svg {...p}>
      <path d="M12 12 L12 3 A9 9 0 0 1 19.79 16.5 Z" fill={C.blue} />
      <path d="M12 12 L19.79 16.5 A9 9 0 0 1 7.5 19.79 Z" fill={C.orange} />
      <path d="M12 12 L7.5 19.79 A9 9 0 0 1 12 3 Z" fill={C.yellow} />
    </Svg>
  ),

  // 环形图
  donut: (p) => (
    <Svg {...p}>
      <path
        d="M12 3 A9 9 0 0 1 19.79 16.5 L16.33 14.5 A5 5 0 0 0 12 7 Z"
        fill={C.blue}
      />
      <path
        d="M19.79 16.5 A9 9 0 0 1 7.5 19.79 L9.5 16.33 A5 5 0 0 0 16.33 14.5 Z"
        fill={C.orange}
      />
      <path
        d="M7.5 19.79 A9 9 0 0 1 12 3 L12 7 A5 5 0 0 0 9.5 16.33 Z"
        fill={C.yellow}
      />
    </Svg>
  ),

  // 散点图
  scatter: (p) => (
    <Svg {...p}>
      <path
        d="M4 3 V20 H21"
        fill="none"
        stroke={C.gray}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="15" r="1.7" fill={C.blue} />
      <circle cx="12" cy="10" r="1.7" fill={C.orange} />
      <circle cx="15.5" cy="13" r="1.7" fill={C.yellow} />
      <circle cx="18.5" cy="7" r="1.7" fill={C.pink} />
      <circle cx="10" cy="7.5" r="1.7" fill={C.violet} />
    </Svg>
  ),

  // 树状图
  treemap: (p) => (
    <Svg {...p}>
      <rect x="3" y="3" width="10" height="18" rx="0.8" fill={C.blue} />
      <rect x="14" y="3" width="7" height="10" rx="0.8" fill={C.orange} />
      <rect x="14" y="14" width="7" height="7" rx="0.8" fill={C.yellow} />
    </Svg>
  ),

  // 漏斗图
  funnel: (p) => (
    <Svg {...p}>
      <path d="M3 4 H21 L18 8.5 H6 Z" fill={C.blue} />
      <path d="M6 10 H18 L16 14.5 H8 Z" fill={C.orange} />
      <path d="M8 16 H16 L14 20 H10 Z" fill={C.yellow} />
    </Svg>
  ),

  // 径向条形图 / 仪表盘
  radialBar: (p) => (
    <Svg {...p}>
      <path
        d="M16.5 19.79 A9 9 0 1 1 16.5 4.21"
        fill="none"
        stroke={C.blue}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M15 17.196 A6 6 0 1 1 15 6.804"
        fill="none"
        stroke={C.orange}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M13.5 14.598 A3 3 0 1 1 13.5 9.402"
        fill="none"
        stroke={C.yellow}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </Svg>
  ),

  // 表格
  table: (p) => (
    <Svg {...p}>
      <rect
        x="3"
        y="4.5"
        width="18"
        height="15"
        rx="1.5"
        fill="none"
        stroke={C.navy}
        strokeWidth="1.4"
      />
      <line x1="3" y1="9.5" x2="21" y2="9.5" stroke={C.navy} strokeWidth="1.4" />
      <line x1="3" y1="14.5" x2="21" y2="14.5" stroke={C.navy} strokeWidth="1.4" />
      <line x1="11" y1="4.5" x2="11" y2="19.5" stroke={C.navy} strokeWidth="1.4" />
    </Svg>
  ),

  // 数值卡
  kpi: (p) => (
    <Svg {...p}>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        fill="none"
        stroke={C.gray}
        strokeWidth="1.3"
      />
      <rect x="6" y="8.5" width="9" height="2.6" rx="1.3" fill={C.blue} />
      <rect x="6" y="14" width="6" height="2" rx="1" fill={C.orange} />
    </Svg>
  ),

  // 填充地图
  map: (p) => (
    <Svg {...p}>
      <path
        d="M3 6.5 L9 4 L15 6.5 L21 4 V17.5 L15 20 L9 17.5 L3 20 Z"
        fill={C.blue}
        fillOpacity="0.25"
        stroke={C.navy}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 4 L9 17.5" stroke={C.navy} strokeWidth="1" />
      <path d="M15 6.5 L15 20" stroke={C.navy} strokeWidth="1" />
      <circle cx="8" cy="12" r="1.4" fill={C.blue} />
      <circle cx="13" cy="9" r="1.4" fill={C.orange} />
      <circle cx="14.5" cy="14" r="1.4" fill={C.yellow} />
    </Svg>
  ),

  // 数据透视表（矩阵：交叉表 + 行列总计）
  matrix: (p) => (
    <Svg {...p}>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="1.5"
        fill="none"
        stroke={C.navy}
        strokeWidth="1.3"
      />
      <line x1="3" y1="9" x2="21" y2="9" stroke={C.navy} strokeWidth="1.1" />
      <line x1="3" y1="15" x2="21" y2="15" stroke={C.navy} strokeWidth="1" />
      <line x1="10" y1="4" x2="10" y2="20" stroke={C.navy} strokeWidth="1" />
      <line x1="15.5" y1="4" x2="15.5" y2="20" stroke={C.navy} strokeWidth="1" />
      <rect x="3.9" y="4.9" width="5.3" height="2.9" fill={C.blue} fillOpacity="0.5" />
      <rect x="10.9" y="9.9" width="3.7" height="4.2" fill={C.blue} fillOpacity="0.35" />
      <rect x="16.4" y="9.9" width="3.7" height="4.2" fill={C.orange} fillOpacity="0.35" />
      <rect x="10.9" y="15.9" width="3.7" height="3.2" fill={C.yellow} fillOpacity="0.5" />
      <rect x="16.4" y="15.9" width="3.7" height="3.2" fill={C.yellow} fillOpacity="0.5" />
    </Svg>
  ),
};
