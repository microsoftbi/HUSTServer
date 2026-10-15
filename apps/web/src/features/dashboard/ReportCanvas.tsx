import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GripVertical, LayoutDashboard, Trash2 } from "lucide-react";
import { ChartRenderer } from "./ChartRenderer";
import { cn } from "@bi/lib/utils";
import { autoTitle } from "@bi/lib/chart";
import {
  clampRect,
  resizeRect,
  snapMove,
  snapResize,
  type Rect,
  type ResizeDir,
} from "@bi/lib/canvas";
import type { ChartWidget, Dataset, WidgetLayout } from "@bi/types";
import type { HighlightSelection } from "@bi/lib/highlight";

interface ReportCanvasProps {
  widgets: ChartWidget[];
  datasets: Dataset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onLayout: (id: string, layout: WidgetLayout) => void;
  onRemove: (id: string) => void;
  /** 当前交叉高亮状态 */
  highlight?: HighlightSelection | null;
  /** 图元点击回调（sourceId 为触发高亮的视觉对象） */
  onPointClick?: (
    sourceId: string,
    field: string,
    value: string,
    additive: boolean,
  ) => void;
}

interface DragState {
  id: string;
  mode: "move" | ResizeDir;
  startX: number;
  startY: number;
  origin: Rect;
  cursor: string;
}

/** 指针按下后登记的「候选拖动」，位移超过阈值才升级为真正的拖动 */
interface PendingDrag {
  id: string;
  mode: "move" | ResizeDir;
  startX: number;
  startY: number;
  origin: Rect;
}

const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** 判断指针是否落在交互元素上（按钮/输入等不应触发整块拖动） */
const INTERACTIVE_SELECTOR = "button,input,select,textarea,a,[data-no-drag]";

const PAGE_MIN_H = 720;
const PAGE_BOTTOM_GAP = 60;

/** 指针位移超过该阈值（px）才视为拖动，否则按点击处理 */
const DRAG_THRESHOLD = 3;

/**
 * Power BI 风格的报表画布：视觉对象绝对定位、整块可拖、自由缩放，
 * 拖动/缩放时吸附并显示对齐辅助线。
 */
export function ReportCanvas({
  widgets,
  datasets,
  selectedId,
  onSelect,
  onLayout,
  onRemove,
  highlight = null,
  onPointClick,
}: ReportCanvasProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [pageW, setPageW] = useState(1200);

  const pageH = useMemo(() => {
    const maxBottom = widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0);
    return Math.max(PAGE_MIN_H, maxBottom + PAGE_BOTTOM_GAP);
  }, [widgets]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });

  // 供 window 事件监听读取的最新值（避免频繁重订阅）
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<PendingDrag | null>(null);
  const suppressClickRef = useRef(false);
  const previewRef = useRef<Rect | null>(null);
  const widgetsRef = useRef(widgets);
  const pageRef = useRef({ w: pageW, h: pageH });
  const onLayoutRef = useRef(onLayout);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);
  useEffect(() => {
    pageRef.current = { w: pageW, h: pageH };
  }, [pageW, pageH]);
  useEffect(() => {
    onLayoutRef.current = onLayout;
  }, [onLayout]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // 测量画布可用宽度
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const update = () => setPageW(el.clientWidth);
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
      // 仅登记候选拖动，不做任何状态更新/阻止默认行为：
      // 这样普通点击不会触发重渲染，图表图元的 click 事件得以正常派发。
      pendingRef.current = {
        id: widget.id,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        origin: widget.layout,
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
        };
        dragRef.current = state;
        previewRef.current = p.origin;
        setDrag(state);
        d = state;
      }
      const { w: pw, h: ph } = pageRef.current;
      const others = widgetsRef.current
        .filter((w) => w.id !== d.id)
        .map((w) => w.layout);
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;

      if (d.mode === "move") {
        const raw: Rect = {
          x: d.origin.x + dx,
          y: d.origin.y + dy,
          w: d.origin.w,
          h: d.origin.h,
        };
        const snapped = snapMove(clampRect(raw, pw, ph), others, pw, ph);
        previewRef.current = snapped.rect;
        setPreview(snapped.rect);
        setGuides({ v: snapped.vLines, h: snapped.hLines });
      } else {
        const base = clampRect(resizeRect(d.origin, d.mode, dx, dy), pw, ph);
        const snapped = snapResize(base, d.mode, others, pw, ph);
        const finalRect = clampRect(snapped.rect, pw, ph);
        previewRef.current = finalRect;
        setPreview(finalRect);
        setGuides({ v: snapped.vLines, h: snapped.hLines });
      }
    }

    function onUp() {
      pendingRef.current = null;
      const d = dragRef.current;
      if (!d) return;
      // 确实是拖动：吞掉紧随其后的 click，避免误触图元选中/高亮
      suppressClickRef.current = true;
      const rect = previewRef.current;
      if (
        rect &&
        (rect.x !== d.origin.x ||
          rect.y !== d.origin.y ||
          rect.w !== d.origin.w ||
          rect.h !== d.origin.h)
      ) {
        onLayoutRef.current(d.id, rect);
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
        if (e.target === e.currentTarget) onSelect(null);
      }}
    >
      {widgets.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <LayoutDashboard className="h-10 w-10" />
          <p className="text-sm">
            {datasets.length === 0
              ? "请先点击「数据」窗格的 ＋ 添加数据集，再新建图表"
              : "点击「新建图表」，或从右侧数据窗格拖入字段"}
          </p>
        </div>
      ) : null}

      {widgets.map((w) => {
        const dataset = datasets.find((d) => d.id === w.datasetId);
        const isSelected = selectedId === w.id;
        const isDragging = drag?.id === w.id;
        const rect = isDragging && preview ? preview : w.layout;
        const showTitle = w.showTitle ?? true;
        const title = w.title.trim() || autoTitle(w.encoding);
        return (
          <div
            key={w.id}
            onPointerDown={(e) => handleWidgetPointerDown(e, w)}
            onClick={() => onSelect(w.id)}
            className={cn(
              "group absolute flex touch-none select-none flex-col rounded-md border bg-background shadow-sm",
              isSelected ? "z-10 ring-2 ring-[#2563eb]" : "z-0",
              isDragging && "z-30 opacity-90 shadow-xl",
            )}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
            }}
          >
            {/* Power BI 风格：视觉对象标题为图表左上角的纯文本，不设标题栏 */}
            {showTitle && title ? (
              <div className="pointer-events-none absolute left-2 top-1.5 z-10 max-w-[calc(100%-4rem)] truncate text-xs font-medium text-foreground/70">
                {title}
              </div>
            ) : null}

            {/* 悬停/选中时右上角浮出操作按钮（抓取 + 删除），不占用图表空间 */}
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

            <div className={cn("min-h-0 flex-1 overflow-hidden p-2", showTitle && title && "pt-6")}>
              <ChartRenderer
                widget={w}
                dataset={dataset}
                highlight={highlight}
                onPointClick={
                  onPointClick
                    ? (field, value, additive) =>
                        onPointClick(w.id, field, value, additive)
                    : undefined
                }
              />
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
