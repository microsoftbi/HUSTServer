import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ChartWidget, Dataset } from "@bi/types";
import { formatCell } from "@bi/lib/format";
import { cellOpacity, type HighlightSelection } from "@bi/lib/highlight";
import {
  buildTreemapGroups,
  categoryColor,
  fitFontSize,
  fitLabel,
  lighten,
  squarify,
  treemapOf,
  valueColor,
  type Box,
  type TreemapGroup,
} from "@bi/lib/treemap";

interface TreemapChartProps {
  widget: ChartWidget;
  dataset: Dataset;
  highlight?: HighlightSelection | null;
  onPointClick?: (field: string, value: string, additive: boolean) => void;
}

/** 布局后的图块：背景块不可交互，前景块承载十字筛选与提示 */
interface RenderedTile {
  key: string;
  rect: Box;
  fill: string;
  opacity: number;
  background?: boolean;
  group: TreemapGroup;
  leafName: string;
  value: number;
}

interface RenderedLabel {
  key: string;
  x: number;
  y: number;
  text: string;
  value?: string;
  color: string;
  font: number;
  valueFont: number;
}

interface HoverState {
  group: TreemapGroup;
  leafName: string;
  value: number;
  x: number;
  y: number;
}

/**
 * Power BI 风格的树状图：类别 → 详细信息两级布局（Squarified 算法），
 * 图块面积与值成正比；支持分组标题、值标签、图例、悬浮提示与十字筛选。
 */
export function TreemapChart({
  widget,
  dataset,
  highlight = null,
  onPointClick,
}: TreemapChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const config = useMemo(() => treemapOf(widget), [widget.treemap]);
  const groups = useMemo(
    () => buildTreemapGroups(dataset, widget.encoding),
    [dataset, widget.encoding],
  );

  /** 是否使用了「详细级别」字段（决定分组背景、图例与配色维度） */
  const hasDetails = useMemo(
    () => groups.some((g) => g.leaves.some((leaf) => leaf.name !== g.name)),
    [groups],
  );

  /** 图例顺序：按明细总值降序，颜色与图块保持一致 */
  const detailOrder = useMemo(() => {
    const totals = new Map<string, number>();
    for (const group of groups) {
      for (const leaf of group.leaves) {
        if (leaf.name === group.name) continue;
        totals.set(leaf.name, (totals.get(leaf.name) ?? 0) + leaf.value);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }, [groups]);

  const detailColorIndex = useMemo(() => {
    const map = new Map<string, number>();
    detailOrder.forEach((name, index) => map.set(name, index));
    return map;
  }, [detailOrder]);

  const maxLeafValue = useMemo(
    () =>
      groups.reduce(
        (max, group) =>
          group.leaves.reduce((m, leaf) => Math.max(m, leaf.value), max),
        0,
      ),
    [groups],
  );

  const grandTotal = useMemo(
    () => groups.reduce((sum, group) => sum + group.value, 0),
    [groups],
  );

  const showLegend =
    (widget.showLegend ?? true) && hasDetails && config.colorMode === "category";

  const layout = useMemo(() => {
    const tiles: RenderedTile[] = [];
    const labels: RenderedLabel[] = [];
    if (size.w <= 0 || size.h <= 0 || groups.length === 0) {
      return { tiles, labels };
    }

    const legendHeight = showLegend ? 22 : 0;
    const gap = Math.max(0, Math.min(8, config.groupPadding));
    const plot: Box = {
      x: 1,
      y: legendHeight + 1,
      w: Math.max(0, size.w - 2),
      h: Math.max(0, size.h - legendHeight - 2),
    };

    /** 计算标签：空间不足自动缩小字号，再截断（对齐 Power BI 数据标签） */
    const pushLabel = (
      key: string,
      rect: Box,
      text: string,
      value: string | undefined,
      color: string,
      maxFont: number,
    ) => {
      if (rect.w < 30 || rect.h < 18) return;
      const maxWidth = rect.w - 8;
      const font = fitFontSize(text, maxWidth, Math.min(maxFont, rect.h / 2));
      const shown = fitLabel(text, maxWidth, font);
      if (!shown) return;
      let valueText: string | undefined;
      let valueFont = font;
      if (config.showValueLabels && value && rect.h - font - 5 >= 9) {
        valueFont = Math.max(8, font - 2);
        valueText = fitLabel(value, maxWidth, valueFont);
      }
      labels.push({
        key,
        x: rect.x + 4,
        y: rect.y + 3 + font,
        text: shown,
        value: valueText,
        color,
        font,
        valueFont,
      });
    };

    const groupTiles = squarify(groups, plot);

    groupTiles.forEach((tile, groupIndex) => {
      const group = tile.item;
      const rect: Box = {
        x: tile.rect.x + gap / 2,
        y: tile.rect.y + gap / 2,
        w: Math.max(0, tile.rect.w - gap),
        h: Math.max(0, tile.rect.h - gap),
      };
      if (rect.w <= 1 || rect.h <= 1) return;

      const opacity = cellOpacity(
        highlight,
        widget.encoding.dimension,
        group.name,
      );
      const base =
        config.colorMode === "category"
          ? categoryColor(groupIndex)
          : config.baseColor;

      // 是否需要在分组内再铺一层明细图块
      const nested = group.leaves.some((leaf) => leaf.name !== group.name);

      if (!nested) {
        const leaf = group.leaves[0];
        const fill =
          config.colorMode === "category"
            ? base
            : valueColor(group.value, maxLeafValue, config.baseColor, config.colorMode);
        tiles.push({
          key: `g-${groupIndex}`,
          rect,
          fill,
          opacity,
          group,
          leafName: group.name,
          value: leaf?.value ?? group.value,
        });
        pushLabel(
          `g-${groupIndex}`,
          rect,
          group.name,
          formatCell(leaf?.value ?? group.value),
          config.labelColor,
          config.labelFontSize,
        );
        return;
      }

      // 分组背景 + 类别标题（有空间时）
      const headerHeight =
        config.showCategoryLabels && rect.w >= 48 && rect.h >= 40 ? 16 : 0;
      tiles.push({
        key: `bg-${groupIndex}`,
        rect,
        fill: lighten(base, 0.88),
        opacity: 1,
        background: true,
        group,
        leafName: group.name,
        value: group.value,
      });
      if (headerHeight > 0) {
        const header = fitLabel(group.name, rect.w - 8, 11);
        if (header) {
          labels.push({
            key: `h-${groupIndex}`,
            x: rect.x + 4,
            y: rect.y + 12,
            text: header,
            color: "#475569",
            font: 11,
            valueFont: 11,
          });
        }
      }

      const innerGap = Math.min(2, gap);
      const inner: Box = {
        x: rect.x + innerGap,
        y: rect.y + headerHeight + innerGap,
        w: Math.max(0, rect.w - innerGap * 2),
        h: Math.max(0, rect.h - headerHeight - innerGap * 2),
      };
      if (inner.w <= 0 || inner.h <= 0) return;

      const childTiles = squarify(group.leaves, inner);
      childTiles.forEach((child, childIndex) => {
        const leaf = child.item;
        const fill =
          config.colorMode === "category"
            ? categoryColor(detailColorIndex.get(leaf.name) ?? childIndex)
            : config.colorMode === "single"
              ? config.baseColor
              : valueColor(leaf.value, maxLeafValue, config.baseColor);
        const key = `c-${groupIndex}-${childIndex}`;
        tiles.push({
          key,
          rect: child.rect,
          fill,
          opacity,
          group,
          leafName: leaf.name,
          value: leaf.value,
        });
        pushLabel(
          key,
          child.rect,
          leaf.name,
          formatCell(leaf.value),
          config.labelColor,
          config.labelFontSize,
        );
      });
    });

    return { tiles, labels };
  }, [
    size,
    groups,
    config,
    highlight,
    widget.encoding.dimension,
    showLegend,
    detailColorIndex,
    maxLeafValue,
  ]);

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {dataset.rows.length === 0
          ? "无数据"
          : "没有可用于树状图的正值，请检查度量字段"}
      </div>
    );
  }

  /** 提示信息定位：靠近指针，且不超出视觉对象边界 */
  const tooltipLeft = hover
    ? Math.min(hover.x + 12, Math.max(0, size.w - 176))
    : 0;
  const tooltipTop = hover
    ? Math.min(hover.y + 12, Math.max(0, size.h - 88))
    : 0;

  const legendItems = detailOrder.slice(0, 16);

  return (
    <div ref={ref} className="relative h-full w-full">
      <svg
        width={size.w}
        height={size.h}
        role="img"
        aria-label={`树状图：${groups.length} 个分组`}
      >
        {showLegend ? (
          <g>
            {legendItems.map((name, index) => {
              const x = 4 + index * 84;
              if (x > Math.max(0, size.w - 60)) return null;
              return (
                <g key={name}>
                  <rect
                    x={x}
                    y={5}
                    width={9}
                    height={9}
                    rx={1.5}
                    fill={categoryColor(detailColorIndex.get(name) ?? index)}
                  />
                  <text
                    x={x + 13}
                    y={13}
                    fontSize={10}
                    fill="#475569"
                    className="pointer-events-none"
                  >
                    {fitLabel(name, 64, 10)}
                  </text>
                </g>
              );
            })}
          </g>
        ) : null}

        {layout.tiles.map((tile) => {
          return (
            <rect
              key={tile.key}
              x={tile.rect.x}
              y={tile.rect.y}
              width={Math.max(0, tile.rect.w)}
              height={Math.max(0, tile.rect.h)}
              rx={tile.background ? 2 : 1.5}
              fill={tile.fill}
              fillOpacity={tile.opacity}
              stroke={config.showBorder ? "#ffffff" : "none"}
              strokeWidth={config.showBorder ? 1 : 0}
              className={
                tile.background
                  ? undefined
                  : onPointClick && widget.encoding.dimension
                    ? "cursor-pointer"
                    : undefined
              }
              onMouseEnter={(e) => {
                if (tile.background) return;
                const box = ref.current?.getBoundingClientRect();
                if (!box) return;
                setHover({
                  group: tile.group,
                  leafName: tile.leafName,
                  value: tile.value,
                  x: e.clientX - box.left,
                  y: e.clientY - box.top,
                });
              }}
              onMouseMove={(e) => {
                if (tile.background) return;
                const box = ref.current?.getBoundingClientRect();
                if (!box) return;
                setHover({
                  group: tile.group,
                  leafName: tile.leafName,
                  value: tile.value,
                  x: e.clientX - box.left,
                  y: e.clientY - box.top,
                });
              }}
              onMouseLeave={() => {
                if (!tile.background) setHover(null);
              }}
              onClick={(e: MouseEvent) => {
                if (tile.background || !onPointClick || !widget.encoding.dimension) return;
                onPointClick(
                  widget.encoding.dimension,
                  tile.group.name,
                  e.metaKey || e.ctrlKey,
                );
              }}
            />
          );
        })}

        {layout.labels.map((label) => (
          <g key={label.key} className="pointer-events-none">
            <text
              x={label.x}
              y={label.y}
              fontSize={label.font}
              fill={label.color}
              fontWeight={500}
            >
              {label.text}
            </text>
            {label.value ? (
              <text
                x={label.x}
                y={label.y + label.font + 2}
                fontSize={label.valueFont}
                fill={label.color}
                fillOpacity={0.85}
              >
                {label.value}
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      {hover ? (
        <div
          className="pointer-events-none absolute z-20 w-40 rounded-md border bg-background/95 p-2 text-[11px] shadow-md backdrop-blur-sm"
          style={{ left: tooltipLeft, top: tooltipTop }}
        >
          <div className="truncate font-medium">{hover.group.name}</div>
          {hasDetails && hover.leafName !== hover.group.name ? (
            <div className="truncate text-muted-foreground">{hover.leafName}</div>
          ) : null}
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-muted-foreground">值</span>
            <span className="font-medium tabular-nums">
              {formatCell(hover.value)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">占比</span>
            <span className="tabular-nums">
              {grandTotal > 0
                ? `${((hover.value / grandTotal) * 100).toFixed(1)}%`
                : "-"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
