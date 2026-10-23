import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { FieldFormat, MapRegion } from "@bi/types";
import {
  buildRegionIndex,
  createFitProjection,
  extent,
  featureToPath,
  loadGeo,
  makeColorScale,
  MAP_COLOR_STOPS,
  MAP_NO_DATA_COLOR,
  matchRegion,
  resolveScope,
  type GeoFeatureCollection,
} from "@bi/lib/geo";
import { formatCell } from "@bi/lib/format";
import { cellOpacity, type HighlightSelection } from "@bi/lib/highlight";

interface MapChartProps {
  /** 聚合后的数据：每行含位置字段与度量值 */
  rows: Array<Record<string, string | number | null>>;
  /** 位置（维度）字段名 */
  dimensionKey: string;
  /** 决定着色的度量字段名 */
  valueKey: string;
  /** 地理范围：auto 时按数据自动识别 */
  region?: MapRegion;
  /** 是否显示色阶图例 */
  showLegend?: boolean;
  /** 当前交叉高亮状态 */
  highlight?: HighlightSelection | null;
  /** 度量字段的数值格式 */
  valueFormat?: FieldFormat | null;
  /** 点击区域回调：使用数据标签（非地理名） */
  onPointClick?: (field: string, value: string, additive: boolean) => void;
}

interface MapPath {
  index: number;
  d: string;
  fill: string;
  name: string;
  /** 命中该区域的数据标签（可能多个，如广州/深圳同属广东）；未匹配到数据时为空数组 */
  labels: string[];
  value: number | null;
}

interface HoverInfo {
  name: string;
  value: number | null;
  x: number;
  y: number;
}

const LEGEND_HEIGHT = 26;

/** 填充地图：自绘 SVG，区域名称匹配 → 值决定着色（min→max 顺色阶） */
export function MapChart({
  rows,
  dimensionKey,
  valueKey,
  region,
  showLegend = true,
  highlight = null,
  valueFormat = null,
  onPointClick,
}: MapChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [geo, setGeo] = useState<GeoFeatureCollection | null>(null);
  const [scope, setScope] = useState<"china" | "world" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // 容器尺寸自适应（投影按当前尺寸重新计算）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const values = useMemo(
    () => rows.map((r) => String(r[dimensionKey] ?? "")),
    [rows, dimensionKey],
  );

  // 解析地理范围并懒加载边界数据
  useEffect(() => {
    let cancelled = false;
    setGeo(null);
    setScope(null);
    setError(null);
    resolveScope(region, values)
      .then((resolved) => {
        if (cancelled) return null;
        setScope(resolved);
        return loadGeo(resolved);
      })
      .then((fc) => {
        if (!cancelled && fc) setGeo(fc);
      })
      .catch(() => {
        if (!cancelled) setError("地图数据加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [region, values]);

  const { paths, min, max } = useMemo(() => {
    const empty = { paths: [] as MapPath[], min: 0, max: 0 };
    if (!geo || size.width <= 0 || size.height <= 0) return empty;

    const index = buildRegionIndex(geo);
    // 一个区域可能命中多个数据值（如广州、深圳同属广东，被上卷到省级），
    // 度量按区域求和，标签保留全部命中值（用于高亮与点击）。
    const valueByIndex = new Map<number, number>();
    const labelsByIndex = new Map<number, string[]>();
    for (const row of rows) {
      const label = String(row[dimensionKey] ?? "");
      const idx = matchRegion(label, index);
      if (idx < 0) continue;
      const v = row[valueKey];
      if (typeof v === "number") {
        valueByIndex.set(idx, (valueByIndex.get(idx) ?? 0) + v);
      }
      const labels = labelsByIndex.get(idx);
      if (labels) {
        if (!labels.includes(label)) labels.push(label);
      } else {
        labelsByIndex.set(idx, [label]);
      }
    }
    const [minV, maxV] = extent(Array.from(valueByIndex.values())) ?? [0, 0];
    const colorOf = makeColorScale(minV, maxV);

    const mapHeight = Math.max(size.height - (showLegend ? LEGEND_HEIGHT : 0), 1);
    const proj = createFitProjection(geo, size.width, mapHeight);

    const items: MapPath[] = geo.features.map((f, i) => {
      const name =
        typeof f.properties.name === "string" ? f.properties.name : "";
      const value = valueByIndex.has(i) ? (valueByIndex.get(i) as number) : null;
      return {
        index: i,
        d: featureToPath(f, proj),
        fill: value === null ? MAP_NO_DATA_COLOR : colorOf(value),
        name,
        labels: labelsByIndex.get(i) ?? [],
        value,
      };
    });

    return { paths: items, min: minV, max: maxV };
  }, [geo, size, rows, dimensionKey, valueKey, showLegend]);

  function handleHover(e: MouseEvent, name: string, value: number | null) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ name, value, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  const canRender = geo !== null && paths.length > 0;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {error ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {error}
        </div>
      ) : !canRender ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {scope ? "正在加载地图…" : "正在识别地理范围…"}
        </div>
      ) : (
        <>
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {paths.map((p) => {
              const matched = p.labels.length > 0;
              const clickable = matched && onPointClick;
              // 区域内任一数据值命中高亮即保持实色，否则变暗
              const opacity = matched
                ? Math.max(
                    ...p.labels.map((l) =>
                      cellOpacity(highlight, dimensionKey, l),
                    ),
                  )
                : 1;
              return (
                <path
                  key={p.index}
                  d={p.d}
                  fill={p.fill}
                  fillOpacity={opacity}
                  stroke="#ffffff"
                  strokeWidth={0.6}
                  strokeLinejoin="round"
                  onMouseMove={(e) => handleHover(e, p.name, p.value)}
                  onMouseLeave={() => setHover(null)}
                  onClick={
                    clickable
                      ? (e) =>
                          onPointClick(
                            dimensionKey,
                            p.labels[0],
                            e.metaKey || e.ctrlKey,
                          )
                      : undefined
                  }
                  className={`transition-[stroke] hover:stroke-slate-700 ${
                    clickable ? "cursor-pointer" : "cursor-default"
                  }`}
                  style={{ strokeWidth: hover?.name === p.name ? 1.2 : undefined }}
                />
              );
            })}
          </svg>

          {showLegend ? (
            <div className="pointer-events-none absolute bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="tabular-nums">{formatCell(min, valueFormat)}</span>
              <div
                className="h-2 w-32 rounded-sm"
                style={{
                  background: `linear-gradient(90deg, ${MAP_COLOR_STOPS.join(", ")})`,
                }}
              />
              <span className="tabular-nums">{formatCell(max, valueFormat)}</span>
            </div>
          ) : null}

          {hover ? (
            <div
              className="pointer-events-none absolute z-10 rounded border bg-popover px-2 py-1 text-xs shadow-md"
              style={{ left: hover.x + 12, top: hover.y + 12 }}
            >
              <div className="font-medium">{hover.name || "未知区域"}</div>
              <div className="text-muted-foreground">{formatCell(hover.value, valueFormat)}</div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
