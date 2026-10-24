import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Eye,
  EyeOff,
  GripVertical,
  X,
} from "lucide-react";
import { autoTitle, CHART_TYPE_LABELS } from "@bi/lib/chart";
import { cn } from "@bi/lib/utils";
import type { ChartWidget } from "@bi/types";

interface SelectionPaneProps {
  widgets: ChartWidget[];
  selectedIds: string[];
  onSelect: (id: string, additive?: boolean) => void;
  /** 新的图层顺序：数组越靠后越靠前 */
  onReorder: (ids: string[]) => void;
  onClose: () => void;
  /** 切换视觉对象隐藏状态（眼睛按钮） */
  onToggleHidden?: (id: string) => void;
  /** 提交新的 Tab 顺序（按数组序号写入 1..n） */
  onTabOrderChange?: (items: Array<{ id: string; tabOrder: number }>) => void;
  className?: string;
}

/** 列表项名称：优先标题，其次自动标题，最后是图表类型名 */
function labelOf(widget: ChartWidget): string {
  return widget.title.trim() || autoTitle(widget.encoding) || CHART_TYPE_LABELS[widget.type];
}

const LAYER_ACTIONS: Array<{
  key: "top" | "up" | "down" | "bottom";
  label: string;
  Icon: typeof ChevronsUp;
}> = [
  { key: "top", label: "置于顶层", Icon: ChevronsUp },
  { key: "up", label: "上移一层", Icon: ChevronUp },
  { key: "down", label: "下移一层", Icon: ChevronDown },
  { key: "bottom", label: "置于底层", Icon: ChevronsDown },
];

/** 按 Tab 顺序排序：未设置 tabOrder 的排在最后，保持原有相对顺序 */
function byTabOrder(widgets: ChartWidget[]): ChartWidget[] {
  return [...widgets].sort(
    (a, b) => (a.tabOrder ?? Number.MAX_SAFE_INTEGER) - (b.tabOrder ?? Number.MAX_SAFE_INTEGER),
  );
}

type PaneMode = "layer" | "tab";

/**
 * Power BI 风格的「选择」窗格：
 * 列表按前景 → 背景排列（顶部为最前层），支持拖动或用按钮调整图层顺序；
 * 眼睛按钮切换隐藏；「Tab 顺序」模式调整键盘导航顺序。
 */
export function SelectionPane({
  widgets,
  selectedIds,
  onSelect,
  onReorder,
  onClose,
  onToggleHidden,
  onTabOrderChange,
  className,
}: SelectionPaneProps) {
  /** 显示顺序 = 存储顺序取反（存储中越靠后越靠前） */
  const ordered = useMemo(() => [...widgets].reverse(), [widgets]);
  const tabOrdered = useMemo(() => byTabOrder(widgets), [widgets]);
  const [mode, setMode] = useState<PaneMode>("layer");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const rows = mode === "layer" ? ordered : tabOrdered;
  const anchorId = selectedIds[0] ?? null;
  const anchorIndex = rows.findIndex((w) => w.id === anchorId);

  /** 把「前景 → 背景」的显示顺序写回存储顺序 */
  function commit(displayIds: string[]) {
    onReorder([...displayIds].reverse());
  }

  function move(id: string, action: "top" | "up" | "down" | "bottom") {
    const ids = ordered.map((w) => w.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    ids.splice(from, 1);
    const to =
      action === "top"
        ? 0
        : action === "bottom"
          ? ids.length
          : Math.min(Math.max(from + (action === "up" ? -1 : 1), 0), ids.length);
    ids.splice(to, 0, id);
    commit(ids);
  }

  /** Tab 顺序：与相邻项交换后，按 1..n 重写所有 tabOrder */
  function moveTab(id: string, dir: -1 | 1) {
    const ids = tabOrdered.map((w) => w.id);
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    onTabOrderChange?.(ids.map((wid, i) => ({ id: wid, tabOrder: i + 1 })));
  }

  function dropOn(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = ordered.map((w) => w.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    commit(ids);
    setDragId(null);
    setOverId(null);
  }

  return (
    <aside
      className={cn(
        "flex min-h-0 w-[240px] shrink-0 flex-col border-l bg-background",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <span className="flex-1 text-sm font-semibold">选择</span>
        <button
          type="button"
          aria-label="关闭选择窗格"
          title="关闭"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 图层 / Tab 顺序 模式切换（对齐 Power BI 选择窗格的两种列表） */}
      <div className="flex shrink-0 gap-0.5 border-b px-1.5 py-1">
        {(
          [
            { key: "layer", label: "图层" },
            { key: "tab", label: "Tab 顺序" },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={mode === item.key}
            onClick={() => setMode(item.key)}
            className={cn(
              "flex-1 rounded px-2 py-0.5 text-[11px] transition-colors",
              mode === item.key
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">此页面暂无元素</p>
        ) : (
          rows.map((w, index) => (
            <div
              key={w.id}
              onDragOver={(e) => {
                if (!dragId || mode !== "layer") return;
                e.preventDefault();
                setOverId(w.id);
              }}
              onDragLeave={() => setOverId((cur) => (cur === w.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                if (mode === "layer") dropOn(w.id);
              }}
              onClick={(e) => onSelect(w.id, e.metaKey || e.ctrlKey || e.shiftKey)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors",
                selectedIds.includes(w.id)
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60",
                overId === w.id && dragId && dragId !== w.id && "ring-1 ring-primary",
                dragId === w.id && "opacity-50",
                w.hidden && "opacity-55",
              )}
            >
              {/* 仅拖动手柄触发原生拖拽，避免影响整行点击选中 */}
              <span
                draggable={mode === "layer"}
                title={mode === "layer" ? "拖动调整图层顺序" : undefined}
                onDragStart={() => setDragId(w.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                className={cn(
                  "flex shrink-0 items-center",
                  mode === "layer" ? "cursor-grab" : "cursor-default opacity-40",
                )}
              >
                <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
              {mode === "tab" ? (
                <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
              ) : null}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-foreground/90",
                  w.hidden && "line-through",
                )}
              >
                {labelOf(w)}
              </span>
              <button
                type="button"
                aria-label={w.hidden ? "取消隐藏" : "隐藏视觉对象"}
                aria-pressed={!!w.hidden}
                title={w.hidden ? "取消隐藏" : "隐藏"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHidden?.(w.id);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {w.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {CHART_TYPE_LABELS[w.type]}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t px-1.5 py-1">
        <div className="flex items-center gap-0.5">
          {mode === "layer"
            ? LAYER_ACTIONS.map(({ key, label, Icon }) => {
                const disabled =
                  anchorIndex < 0 ||
                  ((key === "top" || key === "up") && anchorIndex === 0) ||
                  ((key === "bottom" || key === "down") &&
                    anchorIndex === ordered.length - 1);
                return (
                  <button
                    key={key}
                    type="button"
                    title={label}
                    aria-label={label}
                    disabled={disabled}
                    onClick={() => anchorId && move(anchorId, key)}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors",
                      disabled
                        ? "cursor-not-allowed opacity-40"
                        : "hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })
            : (
                <>
                  <button
                    type="button"
                    title="上移 Tab 顺序"
                    aria-label="上移 Tab 顺序"
                    disabled={anchorIndex <= 0}
                    onClick={() => anchorId && moveTab(anchorId, -1)}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors",
                      anchorIndex <= 0
                        ? "cursor-not-allowed opacity-40"
                        : "hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="下移 Tab 顺序"
                    aria-label="下移 Tab 顺序"
                    disabled={anchorIndex < 0 || anchorIndex >= tabOrdered.length - 1}
                    onClick={() => anchorId && moveTab(anchorId, 1)}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors",
                      anchorIndex < 0 || anchorIndex >= tabOrdered.length - 1
                        ? "cursor-not-allowed opacity-40"
                        : "hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </>
              )}
          <span className="ml-auto pr-1 text-[10px] text-muted-foreground">
            已选 {selectedIds.length}
          </span>
        </div>
        <p className="px-1 pb-0.5 text-[10px] text-muted-foreground">
          {mode === "layer"
            ? "列表顶部为最前层，可拖动或使用按钮调整。"
            : "数字越小越先获得焦点，可上下调整。"}
        </p>
      </div>
    </aside>
  );
}
