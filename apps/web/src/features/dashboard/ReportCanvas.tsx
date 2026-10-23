import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GripVertical, LayoutDashboard, Trash2 } from "lucide-react";
import { ChartRenderer } from "./ChartRenderer";
import { SlicerWidgetView } from "./SlicerWidgetView";
import { cn } from "@bi/lib/utils";
import { autoTitle } from "@bi/lib/chart";
import { isDecoration } from "@bi/lib/decoration";
import { boxStyleOf, styleOf } from "@bi/lib/style";
import {
  clampRect,
  MIN_FILTER_SIZE,
  MIN_WIDGET_SIZE,
  resizeRect,
  snapMove,
  snapResize,
  type Rect,
  type ResizeDir,
  type SizeLimit,
} from "@bi/lib/canvas";
import type {
  ChartType,
  ChartWidget,
  Dataset,
  SlicerConfig,
  WidgetLayout,
} from "@bi/types";
import type { HighlightSelection, ValueFilter } from "@bi/lib/highlight";

interface ReportCanvasProps {
  widgets: ChartWidget[];
  datasets: Dataset[];
  /** 已选中的视觉对象 id（支持多选对齐/分布） */
  selectedIds: string[];
  onSelect: (id: string | null, additive?: boolean) => void;
  onLayout: (id: string, layout: WidgetLayout) => void;
  /** 多选整体拖动时一次性提交多个位置 */
  onLayoutMany?: (items: Array<{ id: string; layout: WidgetLayout }>) => void;
  onRemove: (id: string) => void;
  /** 只读预览：不可拖动 / 缩放 / 删除，也不显示选中框与操作按钮 */
  readOnly?: boolean;
  /** 当前交叉筛选状态：源视觉对象变暗未选项，同数据集其它图表按选中值过滤 */
  highlight?: HighlightSelection | null;
  /** 仪表板级筛选器取值：所有图表统一按字段=值过滤 */
  filters?: ValueFilter[] | null;
  /** 图元点击回调（sourceId 为触发高亮的视觉对象） */
  onPointClick?: (
    sourceId: string,
    field: string,
    value: string,
    additive: boolean,
  ) => void;
  /** 从可视化画廊拖放视觉对象到画布（x/y 为画布内坐标） */
  onDropVisual?: (type: ChartType, x: number, y: number) => void;
  /** 切片器选择变化（编辑与浏览模式下都即时生效） */
  onSlicerChange?: (widgetId: string, slicer: SlicerConfig) => void;
  /** 视觉对象自身配置变更（如分解树的展开状态、文本框内容） */
  onWidgetChange?: (widgetId: string, patch: Partial<ChartWidget>) => void;
  /** 固定画布宽度（页面设置）；0 / 未设置时适应容器宽度 */
  pageWidth?: number;
  /** 固定画布高度（页面设置）；0 / 未设置时随内容自动增高 */
  pageHeight?: number;
}

interface DragState {
  id: string;
  mode: "move" | ResizeDir;
  startX: number;
  startY: number;
  origin: Rect;
  cursor: string;
  /** 多选整体拖动时，其余选中项的原始位置 */
  peers: Array<{ id: string; rect: Rect }>;
}

/** 指针按下后登记的「候选拖动」，位移超过阈值才升级为真正的拖动 */
type PendingDrag = Omit<DragState, "cursor">;

const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** 判断指针是否落在交互元素上（按钮/输入等不应触发整块拖动） */
const INTERACTIVE_SELECTOR = "button,input,select,textarea,a,[data-no-drag]";

const PAGE_MIN_H = 720;
const PAGE_BOTTOM_GAP = 60;

/** 指针位移超过该阈值（px）才视为拖动，否则按点击处理 */
const DRAG_THRESHOLD = 3;

function sizeLimitOf(widget: ChartWidget | undefined): SizeLimit {
  return widget?.type === "filter" ? MIN_FILTER_SIZE : MIN_WIDGET_SIZE;
}

/**
 * Power BI 风格的报表画布：视觉对象绝对定位、整块可拖、自由缩放，
 * 拖动/缩放时吸附并显示对齐辅助线。
 */
export function ReportCanvas({
  widgets,
  datasets,
  selectedIds,
  onSelect,
  onLayout,
  onLayoutMany,
  onRemove,
  readOnly = false,
  highlight = null,
  filters = null,
  onPointClick,
  onDropVisual,
  onSlicerChange,
  onWidgetChange,
  pageWidth = 0,
  pageHeight = 0,
}: ReportCanvasProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [measuredW, setMeasuredW] = useState(1200);

  const autoH = useMemo(() => {
    const maxBottom = widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0);
    return Math.max(PAGE_MIN_H, maxBottom + PAGE_BOTTOM_GAP);
  }, [widgets]);

  // 页面设置优先：固定宽/高时不再随容器与内容变化
  const pageW = pageWidth > 0 ? pageWidth : measuredW;
  const pageH = pageHeight > 0 ? pageHeight : autoH;

  /** 触发交叉筛选的视觉对象所属数据集：仅同数据集内的其它图表参与过滤 */
  const sourceDatasetId = useMemo(() => {
    if (!highlight) return null;
    return widgets.find((w) => w.id === highlight.sourceId)?.datasetId ?? null;
  }, [highlight, widgets]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<Record<string, Rect> | null>(null);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });

  // 供 window 事件监听读取的最新值（避免频繁重订阅）
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<PendingDrag | null>(null);
  const suppressClickRef = useRef(false);
  const previewRef = useRef<Record<string, Rect> | null>(null);
  const widgetsRef = useRef(widgets);
  const selectedRef = useRef(selectedIds);
  const pageRef = useRef({ w: pageW, h: pageH });
  const onLayoutRef = useRef(onLayout);
  const onLayoutManyRef = useRef(onLayoutMany);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);
  useEffect(() => {
    selectedRef.current = selectedIds;
  }, [selectedIds]);
  useEffect(() => {
    pageRef.current = { w: pageW, h: pageH };
  }, [pageW, pageH]);
  useEffect(() => {
    onLayoutRef.current = onLayout;
  }, [onLayout]);
  useEffect(() => {
    onLayoutManyRef.current = onLayoutMany;
  }, [onLayoutMany]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // 测量画布可用宽度
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const update = () => setMeasuredW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 拖动期间锁定文本选择与光标
  useEffect(() => {
    if (!drag) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = drag.cursor;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [drag]);

  const beginDrag = useCallback(
    (widget: ChartWidget, mode: "move" | ResizeDir, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 新的指针手势开始：清除可能残留的「吞掉下一次 click」标志
      suppressClickRef.current = false;
      const selection = selectedRef.current;
      // 多选时拖动其中任一项，整组同步位移
      const peers =
        mode === "move" && selection.length > 1 && selection.includes(widget.id)
          ? widgetsRef.current
              .filter((w) => w.id !== widget.id && selection.includes(w.id))
              .map((w) => ({ id: w.id, rect: w.layout }))
          : [];
      // 仅登记候选拖动，不做任何状态更新/阻止默认行为：
      // 这样普通点击不会触发重渲染，图表图元的 click 事件得以正常派发。
      pendingRef.current = {
        id: widget.id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        origin: widget.layout,
        peers,
      };
    },
    [],
  );

  const handleWidgetPointerDown = useCallback(
    (e: React.PointerEvent, widget: ChartWidget) => {
      if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
      beginDrag(widget, "move", e);
    },
    [beginDrag],
  );

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, widget: ChartWidget, dir: ResizeDir) => {
      e.stopPropagation();
      beginDrag(widget, dir, e);
    },
    [beginDrag],
  );

  // 全局指针事件：位移超阈值后进入拖动/缩放 + 吸附 + 释放提交
  useEffect(() => {
    function onMove(e: PointerEvent) {
      let d = dragRef.current;
      if (!d) {
        // 尚未进入拖动：检查候选拖动是否已超过位移阈值
        const p = pendingRef.current;
        if (!p) return;
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < DRAG_THRESHOLD) {
          return;
        }
        onSelectRef.current(p.id);
        const state: DragState = {
          id: p.id,
          mode: p.mode,
          startX: p.startX,
          startY: p.startY,
          origin: p.origin,
          cursor: p.mode === "move" ? "grabbing" : `${p.mode}-resize`,
          peers: p.peers,
        };
        dragRef.current = state;
        d = state;
      }
      const { w: pw, h: ph } = pageRef.current;
      const movingIds = new Set([d.id, ...d.peers.map((p) => p.id)]);
      const others = widgetsRef.current
        .filter((w) => !movingIds.has(w.id))
        .map((w) => w.layout);
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const min = sizeLimitOf(widgetsRef.current.find((w) => w.id === d.id));

      if (d.mode === "move") {
        const raw: Rect = {
          x: d.origin.x + dx,
          y: d.origin.y + dy,
          w: d.origin.w,
          h: d.origin.h,
        };
        const snapped = snapMove(clampRect(raw, pw, ph, min), others, pw, ph);
        // 组内整体位移：按组外接框夹紧，保持相对位置
        const allRects = [{ rect: d.origin }, ...d.peers];
        const minLeft = Math.min(...allRects.map((r) => r.rect.x));
        const maxRight = Math.max(...allRects.map((r) => r.rect.x + r.rect.w));
        const minTop = Math.min(...allRects.map((r) => r.rect.y));
        const maxBottom = Math.max(...allRects.map((r) => r.rect.y + r.rect.h));
        let ddx = snapped.rect.x - d.origin.x;
        let ddy = snapped.rect.y - d.origin.y;
        ddx = Math.min(Math.max(ddx, -minLeft), Math.max(0, pw - maxRight));
        ddy = Math.min(Math.max(ddy, -minTop), Math.max(0, ph - maxBottom));

        const next: Record<string, Rect> = {
          [d.id]: { ...d.origin, x: d.origin.x + ddx, y: d.origin.y + ddy },
        };
        for (const p of d.peers) {
          next[p.id] = { ...p.rect, x: p.rect.x + ddx, y: p.rect.y + ddy };
        }
        previewRef.current = next;
        setPreview(next);
        setGuides({ v: snapped.vLines, h: snapped.hLines });
      } else {
        const base = clampRect(resizeRect(d.origin, d.mode, dx, dy, min), pw, ph, min);
        const snapped = snapResize(base, d.mode, others, pw, ph, min);
        const finalRect = clampRect(snapped.rect, pw, ph, min);
        previewRef.current = { [d.id]: finalRect };
        setPreview({ [d.id]: finalRect });
        setGuides({ v: snapped.vLines, h: snapped.hLines });
      }
    }

    function onUp() {
      pendingRef.current = null;
      const d = dragRef.current;
      if (!d) return;
      // 确实是拖动：吞掉紧随其后的 click，避免误触图元选中/高亮
      suppressClickRef.current = true;
      const map = previewRef.current ?? {};
      const changes: Array<{ id: string; layout: Rect }> = [];
      for (const [id, rect] of Object.entries(map)) {
        const origin = id === d.id ? d.origin : d.peers.find((p) => p.id === id)?.rect;
        if (!origin) continue;
        if (
          rect.x !== origin.x ||
          rect.y !== origin.y ||
          rect.w !== origin.w ||
          rect.h !== origin.h
        ) {
          changes.push({ id, layout: rect });
        }
      }
      if (changes.length > 0) {
        if (onLayoutManyRef.current) onLayoutManyRef.current(changes);
        else for (const c of changes) onLayoutRef.current(c.id, c.layout);
      }
      dragRef.current = null;
      previewRef.current = null;
      setDrag(null);
      setPreview(null);
      setGuides({ v: [], h: [] });
    }

    // 捕获阶段拦截拖动结束后的 click
    function onClickCapture(e: MouseEvent) {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  return (
    <div
      ref={innerRef}
      className={cn("relative", drag && "select-none")}
      style={{ height: pageH }}
      onClick={(e) => {
        if (readOnly) return;
        if (e.target === e.currentTarget) onSelect(null);
      }}
      onDragOver={(e) => {
        if (readOnly || !onDropVisual) return;
        if (!e.dataTransfer.types.includes("application/x-bi-visual")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        if (readOnly || !onDropVisual) return;
        const type = e.dataTransfer.getData("application/x-bi-visual");
        if (!type) return;
        e.preventDefault();
        const rect = innerRef.current?.getBoundingClientRect();
        if (!rect) return;
        onDropVisual(type as ChartType, e.clientX - rect.left, e.clientY - rect.top);
      }}
    >
      {widgets.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <LayoutDashboard className="h-10 w-10" />
          <p className="text-sm">
            {readOnly
              ? "此仪表板暂无图表"
              : datasets.length === 0
                ? "请先在左侧「数据」标签中添加数据集，再新建图表"
                : "点击「新建图表」，或从右侧数据窗格拖入字段"}
          </p>
        </div>
      ) : null}

      {widgets.map((w) => {
        const dataset = datasets.find((d) => d.id === w.datasetId);
        const isSelected = !readOnly && selectedIds.includes(w.id);
        const rect = preview?.[w.id] ?? w.layout;
        const isMoving = preview?.[w.id] != null;
        // 源视觉对象保持全量（仅变暗未选项），同数据集内的其它图表按选中值过滤后重算
        const crossFilter =
          highlight && dataset && highlight.sourceId !== w.id && dataset.id === sourceDatasetId
            ? { field: highlight.field, values: highlight.values }
            : null;
        // 切片器自带标题栏、装饰元素自带内容，画布层不再叠加标题
        const isFilter = w.type === "filter";
        const isDecor = isDecoration(w.type);
        const showTitle = !isDecor && (w.showTitle ?? true);
        const title = isFilter || isDecor ? "" : w.title.trim() || autoTitle(w.encoding);
        const styled = !!w.style;
        const st = styled ? styleOf(w) : null;
        const hasTitle = showTitle && !!title;
        return (
          <div
            key={w.id}
            onPointerDown={readOnly ? undefined : (e) => handleWidgetPointerDown(e, w)}
            onClick={
              readOnly
                ? undefined
                : (e) => onSelect(w.id, e.metaKey || e.ctrlKey || e.shiftKey)
            }
            className={cn(
              "group absolute flex touch-none select-none flex-col rounded-md",
              !styled && "border bg-background shadow-sm",
              isFilter && !styled && "border-transparent bg-transparent shadow-none",
              isSelected ? "z-10 ring-2 ring-[#2563eb]" : "z-0",
              isMoving && "z-30 opacity-90",
            )}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              ...(styled ? boxStyleOf(w) : {}),
            }}
          >
            {/* Power BI 风格：视觉对象标题为图表左上角的纯文本，不设标题栏 */}
            {hasTitle ? (
              <div
                className={cn(
                  "pointer-events-none absolute left-0 right-0 top-1.5 z-10 truncate px-2 font-medium",
                  !styled && "text-xs text-foreground/70",
                )}
                style={
                  st
                    ? {
                        fontSize: st.titleFontSize,
                        color: st.titleColor,
                        textAlign: st.titleAlign,
                      }
                    : undefined
                }
              >
                {title}
              </div>
            ) : null}

            {/* 悬停/选中时右上角浮出操作按钮（抓取 + 删除），不占用图表空间 */}
            {!readOnly && (
              <div
                className={cn(
                  "absolute right-1 top-1 z-20 flex items-center gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur-sm transition-opacity",
                  isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <span className="flex h-6 w-5 cursor-grab items-center justify-center text-muted-foreground">
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
                <button
                  type="button"
                  data-no-drag
                  aria-label="删除图表"
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(w.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div
              className={cn(
                "min-h-0 flex-1 overflow-hidden",
                isFilter && "p-0",
                isDecor && "p-0",
                !styled && !isFilter && !isDecor && "p-2",
                !styled && !isFilter && !isDecor && hasTitle && "pt-6",
              )}
              style={
                st
                  ? {
                      padding: isFilter ? 0 : st.padding,
                      paddingTop: isFilter
                        ? undefined
                        : hasTitle
                          ? st.padding + st.titleFontSize + 8
                          : st.padding,
                    }
                  : undefined
              }
            >
              {w.type === "filter" ? (
                <SlicerWidgetView
                  widget={w}
                  dataset={dataset}
                  compact={rect.w < 96 || rect.h < 52}
                  onChange={(slicer) => onSlicerChange?.(w.id, slicer)}
                />
              ) : (
                <ChartRenderer
                  widget={w}
                  dataset={dataset}
                  highlight={highlight}
                  crossFilter={crossFilter}
                  filters={filters}
                  onPointClick={
                    onPointClick
                      ? (field, value, additive) =>
                          onPointClick(w.id, field, value, additive)
                      : undefined
                  }
                  onWidgetChange={
                    onWidgetChange
                      ? (patch) => onWidgetChange(w.id, patch)
                      : undefined
                  }
                />
              )}
            </div>

            {isSelected
              ? RESIZE_DIRS.map((dir) => (
                  <span
                    key={dir}
                    data-dir={dir}
                    className="vbi-handle"
                    onPointerDown={(e) => handleResizePointerDown(e, w, dir)}
                  />
                ))
              : null}
          </div>
        );
      })}

      {guides.v.map((x, i) => (
        <div key={`v-${i}`} className="vbi-guide-v" style={{ left: x }} />
      ))}
      {guides.h.map((y, i) => (
        <div key={`h-${i}`} className="vbi-guide-h" style={{ top: y }} />
      ))}
    </div>
  );
}
