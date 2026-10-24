import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceAround,
  Bookmark as BookmarkIcon,
  ChevronDown,
  Image,
  Filter,
  Layers,
  Maximize,
  Pencil,
  Play,
  Plus,
  Scan,
  Settings2,
  SquareDashed,
  StretchHorizontal,
  StretchVertical,
  Shapes,
  Trash2,
  Type,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@bi/components/ui/button";
import { Input } from "@bi/components/ui/input";
import { Label } from "@bi/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bi/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bi/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bi/components/ui/dropdown-menu";
import { ReportCanvas } from "./ReportCanvas";
import { CHART_ICONS } from "./chartIcons";
import { ShapePath, SHAPE_GROUPS } from "@bi/lib/shapes";
import { SelectionPane } from "./SelectionPane";
import { FiltersPane } from "./FiltersPane";
import { BookmarksPane } from "./BookmarksPane";
import { FieldsPane } from "./FieldsPane";
import { VisualizationsPane } from "./VisualizationsPane";
import { useDashboardStore } from "@bi/stores/dashboardStore";
import { useDatasetStore } from "@bi/stores/datasetStore";
import { cn } from "@bi/lib/utils";
import { uid } from "@bi/lib/utils";
import type {
  Bookmark,
  ButtonAction,
  ChartType,
  ChartWidget,
  Column,
  FilterCondition,
  PageConfig,
  PageViewFit,
  SlicerConfig,
  ShapeKind,
  WidgetLayout,
} from "@bi/types";
import { toggleSelection, type HighlightSelection, type ValueFilter } from "@bi/lib/highlight";
import { defaultSlicer, slicerFilters, slicerOf } from "@bi/lib/slicer";
import { defaultDecomposition } from "@bi/lib/decomposition";
import { alignRects, type AlignMode } from "@bi/lib/canvas";
import { DEFAULT_WIDGET_STYLE, PAGE_PRESETS, matchPreset, pageOf } from "@bi/lib/style";
import { BUTTON_ACTIONS, BUTTON_LABELS, defaultDecoration, isDecoration } from "@bi/lib/decoration";

/** 新建视觉对象的默认像素尺寸与级联偏移 */
const DEFAULT_WIDGET_W = 420;
const DEFAULT_WIDGET_H = 280;
/** 切片器视觉对象的默认尺寸（扁平条状，便于并列摆放） */
const FILTER_WIDGET_W = 260;
const FILTER_WIDGET_H = 200;
const CASCADE_STEP = 28;
/** 未设置页面尺寸时的默认画布宽度（对齐 Power BI 默认 1280×720 页面） */
const DEFAULT_PAGE_W = 1280;
const PAGE_MARGIN = 24;

/** 装饰元素的默认尺寸（文本框扁平、图像与形状偏方） */
const DECOR_SIZE: Record<string, { w: number; h: number }> = {
  text: { w: 320, h: 80 },
  button: { w: 200, h: 56 },
  image: { w: 320, h: 200 },
  shape: { w: 240, h: 160 },
};

/** 对齐 / 分布 / 等大工具条的动作定义 */
const ALIGN_ACTIONS: Array<{
  mode: AlignMode;
  label: string;
  Icon: typeof AlignHorizontalJustifyStart;
}> = [
  { mode: "left", label: "左对齐", Icon: AlignHorizontalJustifyStart },
  { mode: "hcenter", label: "水平居中", Icon: AlignHorizontalJustifyCenter },
  { mode: "right", label: "右对齐", Icon: AlignHorizontalJustifyEnd },
  { mode: "top", label: "顶部对齐", Icon: AlignVerticalJustifyStart },
  { mode: "vcenter", label: "垂直居中", Icon: AlignVerticalJustifyCenter },
  { mode: "bottom", label: "底部对齐", Icon: AlignVerticalJustifyEnd },
  { mode: "distributeH", label: "水平分布", Icon: AlignHorizontalSpaceAround },
  { mode: "distributeV", label: "垂直分布", Icon: AlignVerticalSpaceAround },
  { mode: "matchW", label: "等宽", Icon: StretchHorizontal },
  { mode: "matchH", label: "等高", Icon: StretchVertical },
];

type RibbonTab = "home" | "insert" | "view";

/** 视图 → 页面视图：三个缩放选项（下拉菜单内容，对齐 Power BI 的图标 + 文字） */
const PAGE_FIT_OPTIONS: Array<{ value: PageViewFit; label: string; Icon: typeof Plus }> = [
  { value: "page", label: "调整到页面大小", Icon: Maximize },
  { value: "width", label: "适应宽度", Icon: StretchHorizontal },
  { value: "actual", label: "实际大小", Icon: Scan },
];

/** Ribbon Tab 条上的页签 */
function RibbonTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "mb-1 h-7 rounded-md border px-4 text-xs transition-colors",
        active
          ? "border-border bg-background font-semibold text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Ribbon 按钮：图标在上、说明文字在下（Power BI 风格） */
function RibbonButton({
  Icon,
  label,
  onClick,
  disabled = false,
  active = false,
}: {
  Icon: typeof Plus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-[58px] shrink-0 flex-col items-center gap-1 rounded-md px-1 py-1 text-[10px] leading-[12px] transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      <Icon className="h-5 w-5" />
      <span className="w-full text-center">{label}</span>
    </button>
  );
}

/** Ribbon 分组：内容下方显示组名 */
function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col justify-between">
      <div className="flex items-start gap-0.5">{children}</div>
      <span className="pb-0.5 text-center text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

/** Ribbon 复选框：竖向排列的小勾选项（对齐 Power BI 视图 → 网格线 / 锁定对象） */
function RibbonCheck({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex h-5 items-center gap-1.5 rounded px-1.5 text-[11px] transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "cursor-pointer hover:bg-accent hover:text-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 shrink-0 accent-[#2563eb]"
      />
      <span className="whitespace-nowrap">{label}</span>
    </label>
  );
}

/** Ribbon 下拉按钮：大图标 + 固定文字 + 下方小箭头，点开后按图标 + 文字列出选项 */
function RibbonDropdown({
  Icon,
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  Icon: typeof Plus;
  label: string;
  options: Array<{ value: string; label: string; Icon: typeof Plus }>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // 未匹配到当前值时使用传入的 Icon（如「按钮」下拉未选定具体动作时的默认图标）
  const current = options.find((o) => o.value === value);
  const CurrentIcon = current?.Icon ?? Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          title={label}
          aria-label={label}
          aria-haspopup="menu"
          disabled={disabled}
          className={cn(
            "flex w-[76px] shrink-0 flex-col items-center gap-0.5 rounded-md px-1 pt-1 pb-0.5 transition-colors",
            disabled
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-accent hover:text-foreground",
          )}
        >
          <CurrentIcon className="h-6 w-6" />
          <span className="text-[10px] leading-[12px]">{label}</span>
          <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44 p-1">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onSelect={() => onChange(opt.value)}
            className="gap-2 px-1.5 py-1 text-xs"
          >
            <opt.Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="whitespace-nowrap">{opt.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 形状下拉：图标网格 + 分组标题（对齐 Power BI「插入 → 形状」） */
function RibbonShapeMenu({
  disabled = false,
  onPick,
}: {
  disabled?: boolean;
  onPick: (kind: ShapeKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          title="形状"
          aria-label="形状"
          aria-haspopup="menu"
          disabled={disabled}
          className={cn(
            "flex w-[76px] shrink-0 flex-col items-center gap-0.5 rounded-md px-1 pt-1 pb-0.5 transition-colors",
            disabled
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-accent hover:text-foreground",
          )}
        >
          <Shapes className="h-6 w-6" />
          <span className="text-[10px] leading-[12px]">形状</span>
          <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[216px] p-2">
        {SHAPE_GROUPS.map((group) => (
          <div key={group.label} className="mb-1.5 last:mb-0">
            <p className="px-1 pb-1 text-[10px] font-semibold text-muted-foreground">
              {group.label}
            </p>
            <div className="grid grid-cols-4 gap-0.5">
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => onPick(item.key)}
                  className="flex h-8 items-center justify-center rounded text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ShapePath kind={item.key} className="h-4 w-4" strokeWidth={2} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DashboardView({
  onAddDataset,
  readOnly = false,
}: { onAddDataset?: () => void; readOnly?: boolean } = {}) {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);
  const addDashboard = useDashboardStore((s) => s.addDashboard);
  const renameDashboard = useDashboardStore((s) => s.renameDashboard);
  const updateDashboard = useDashboardStore((s) => s.updateDashboard);
  const removeDashboard = useDashboardStore((s) => s.removeDashboard);
  const addWidget = useDashboardStore((s) => s.addWidget);
  const updateWidget = useDashboardStore((s) => s.updateWidget);
  const removeWidget = useDashboardStore((s) => s.removeWidget);
  const reorderWidgets = useDashboardStore((s) => s.reorderWidgets);
  const reportFilters = useDashboardStore((s) => s.reportFilters);
  const setReportFilters = useDashboardStore((s) => s.setReportFilters);
  const syncSlicers = useDashboardStore((s) => s.syncSlicers);
  const setSyncSlicers = useDashboardStore((s) => s.setSyncSlicers);
  const syncSlicerState = useDashboardStore((s) => s.syncSlicerState);

  const datasets = useDatasetStore((s) => s.datasets);

  const active = dashboards.find((d) => d.id === activeId) ?? dashboards[0];
  const widgets = active?.widgets ?? [];
  const page = pageOf(active);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 交叉高亮为瞬时态：不写入 .biproj，切换仪表盘/点击空白/Esc 时清空 */
  const [highlight, setHighlight] = useState<HighlightSelection | null>(null);
  const [browseDatasetId, setBrowseDatasetId] = useState<string>("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [pageOpen, setPageOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  /** Ribbon 当前 Tab 与「选择 / 筛选器」窗格开关 */
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>("home");
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);

  /** 工作区可用尺寸：用于页面视图缩放（适应页面 / 适应宽度） */
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 1200, h: 800 });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () =>
      setViewport({
        w: Math.max(0, el.clientWidth - PAGE_MARGIN * 2),
        h: Math.max(0, el.clientHeight - PAGE_MARGIN * 2),
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 画布在未缩放坐标系下的尺寸：页面设置优先，未设置时用默认页面宽度，不随容器自适应 */
  const baseW = page.width > 0 ? page.width : DEFAULT_PAGE_W;
  const baseH =
    page.height > 0
      ? page.height
      : Math.max(
          720,
          widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0) + 60,
        );

  /** 视图 → 页面视图：适应页面 / 适应宽度 / 实际大小 */
  const pageFit = page.pageFit ?? "actual";
  const zoom = useMemo(() => {
    if (pageFit === "actual") return 1;
    const fitWidth = baseW > 0 ? viewport.w / baseW : 1;
    const raw =
      pageFit === "width" ? fitWidth : Math.min(fitWidth, baseH > 0 ? viewport.h / baseH : 1);
    return Math.min(2, Math.max(0.2, raw));
  }, [pageFit, baseW, baseH, viewport.w, viewport.h]);

  /**
   * 切片器筛选条件：来自所有切片器视觉对象的选择状态，
   * 统一作用于本页所有图表（与 Power BI 的切片器交互一致）。
   */
  const activeValueFilters = useMemo<ValueFilter[]>(() => {
    const out: ValueFilter[] = [];
    for (const w of widgets) {
      if (w.type !== "filter") continue;
      const ds = datasets.find((d) => d.id === w.datasetId);
      out.push(...slicerFilters(w, ds));
    }
    return out;
  }, [widgets, datasets]);

  /** 此页上的筛选器：随仪表板落库，作用于本页所有视觉对象 */
  const pageFilters = active?.filters ?? [];

  // 格式窗格以第一个选中项为编辑对象
  const selected = widgets.find((w) => w.id === selectedIds[0]) ?? null;
  const selectedDataset = datasets.find((d) => d.id === selected?.datasetId);
  const browseDataset = datasets.find((d) => d.id === browseDatasetId) ?? datasets[0];

  // 数据集变化时修正浏览目标
  useEffect(() => {
    if (datasets.length === 0) {
      setBrowseDatasetId("");
      return;
    }
    if (!datasets.some((d) => d.id === browseDatasetId)) {
      setBrowseDatasetId(datasets[0].id);
    }
  }, [datasets, browseDatasetId]);

  // 切换仪表盘时清空选中与高亮
  useEffect(() => {
    setSelectedIds([]);
    setHighlight(null);
  }, [activeId]);

  // Esc 清除交叉高亮
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setHighlight(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 演示模式：Esc 退出，并同步浏览器全屏状态
  useEffect(() => {
    if (!presenting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exitPresent();
    }
    function onFullscreenChange() {
      if (!document.fullscreenElement) setPresenting(false);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [presenting]);

  /** 选中：加选（⌘/Ctrl/Shift）时切换，否则替换整个选区 */
  function handleSelect(id: string | null, additive = false) {
    if (!id) {
      setSelectedIds([]);
      setHighlight(null);
      return;
    }
    setSelectedIds((prev) => {
      if (!additive) return [id];
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }

  /** 图元点击：设置/切换/清除交叉高亮 */
  function handlePointClick(
    sourceId: string,
    field: string,
    value: string,
    additive: boolean,
  ) {
    setHighlight((prev) =>
      toggleSelection(prev, field, value, sourceId, additive),
    );
  }

  function createWidget(
    type: ChartType = "bar",
    action?: ButtonAction,
    shape?: ShapeKind,
  ): ChartWidget | null {
    const isFilter = type === "filter";
    const isDecor = isDecoration(type);
    const ds = browseDataset ?? datasets[0];
    // 装饰元素不绑定数据集，因此不需要先添加数据
    if (!isDecor && !ds) return null;
    // 级联摆放，避免新视觉对象完全重叠
    const step = (widgets.length % 5) * CASCADE_STEP;
    const size = isDecor
      ? DECOR_SIZE[type]
      : isFilter
        ? { w: FILTER_WIDGET_W, h: FILTER_WIDGET_H }
        : { w: DEFAULT_WIDGET_W, h: DEFAULT_WIDGET_H };
    const widget: ChartWidget = {
      id: uid("w"),
      type,
      // 普通图表标题留空 → 画布按字段自动生成（Power BI 风格）
      title: isFilter ? "切片器" : "",
      datasetId: ds?.id ?? "",
      // 字段留空，由用户自行拖拽
      encoding: { measures: [] },
      layout: {
        x: PAGE_MARGIN + step,
        y: PAGE_MARGIN + step,
        w: size.w,
        h: size.h,
      },
      ...(isFilter ? { filterFields: [], slicer: defaultSlicer() } : {}),
      ...(type === "decomposition"
        ? { explainBy: [], decomposition: defaultDecomposition() }
        : {}),
      // 装饰元素默认无边框、无阴影，内容由 decoration 承载
      ...(isDecor
        ? {
            style: {
              ...DEFAULT_WIDGET_STYLE,
              background: "",
              borderWidth: 0,
              shadow: "none" as const,
            },
            decoration: defaultDecoration(type, action, shape),
          }
        : {}),
    };
    addWidget(widget);
    setSelectedIds([widget.id]);
    return widget;
  }

  const DECOR_LABELS: Partial<Record<ChartType, string>> = {
    text: "文本框",
    button: "按钮",
    image: "图像",
    shape: "形状",
  };

  function handleCreate(
    type: ChartType = "bar",
    action?: ButtonAction,
    shape?: ShapeKind,
  ) {
    const widget = createWidget(type, action, shape);
    if (!widget) {
      toast.error("请先在左侧「数据」标签中添加数据集");
      return;
    }
    const decorLabel = DECOR_LABELS[type];
    toast.success(
      decorLabel
        ? `已添加${decorLabel}，可在右侧「设置视觉对象格式」中调整`
        : type === "filter"
          ? "已新建切片器，可在右侧「字段」中拖入数据列"
          : "已新建图表，可在右侧拖入字段",
    );
  }

  /** 清除本页所有切片器的选择（保留切片器本身的配置） */
  function resetSlicers() {
    for (const w of widgets) {
      if (w.type !== "filter") continue;
      updateWidget(w.id, { slicer: { ...slicerOf(w), state: defaultSlicer().state } });
    }
  }

  /** 按钮类装饰元素的动作分发（对齐 Power BI「插入 → 按钮」的动作清单） */
  function runButtonAction(action: ButtonAction) {
    if (!active) return;
    const index = dashboards.findIndex((d) => d.id === active.id);
    if (action === "back" || action === "stepBack") {
      if (index > 0) setActive(dashboards[index - 1].id);
      else toast("已经是第一页");
      return;
    }
    if (action === "next") {
      if (index >= 0 && index < dashboards.length - 1) setActive(dashboards[index + 1].id);
      else toast("已经是最后一页");
      return;
    }
    if (action === "reset") {
      updateDashboard(active.id, { filters: [] });
      resetSlicers();
      toast.success("已重置本页筛选与切片器");
      return;
    }
    if (action === "clearSlicers") {
      resetSlicers();
      toast.success("已清除所有切片器的选择");
      return;
    }
    if (action === "bookmark") {
      setBookmarksOpen(true);
      return;
    }
    if (action === "applySlicers") {
      toast.success("切片器选择已作用于本页视觉对象");
      return;
    }
    if (action === "navigator") {
      toast(`共 ${dashboards.length} 页：${dashboards.map((d) => d.name).join(" / ")}`);
      return;
    }
    if (action === "info" || action === "help" || action === "qa") {
      toast(`「${BUTTON_LABELS[action]}」动作暂未接入外部内容`);
    }
  }

  /** 从可视化画廊拖放：在落点位置创建视觉对象 */
  function handleDropVisual(type: ChartType, x: number, y: number) {
    const widget = createWidget(type);
    if (!widget) {
      toast.error("请先在左侧「数据」标签中添加数据集");
      return;
    }
    const { w, h } = widget.layout;
    updateWidget(widget.id, {
      layout: {
        x: Math.max(PAGE_MARGIN, Math.round(x - w / 2)),
        y: Math.max(PAGE_MARGIN, Math.round(y - h / 2)),
        w,
        h,
      },
    });
  }

  /** 数据面板点击字段：数值列进度量，文本列优先作维度/系列 */
  function handlePickField(col: Column) {
    let target = selected;
    // 装饰元素不承载字段：改在画布上新建一个柱形图
    if (!target || isDecoration(target.type)) {
      target = createWidget("bar");
      if (!target) return;
    }
    // 选中切片器时，点击字段即把它加入筛选字段
    if (target.type === "filter") {
      const fields = target.filterFields ?? [];
      if (!fields.includes(col.name)) {
        const next = [...fields, col.name];
        const cfg = slicerOf(target);
        // 第二个字段起自动切换为层次结构切片器（对齐 Power BI）
        const autoHierarchy =
          next.length > 1 && (cfg.type === "list" || cfg.type === "dropdown");
        updateWidget(target.id, {
          filterFields: next,
          ...(autoHierarchy ? { slicer: { ...cfg, type: "hierarchy" } } : {}),
        });
      }
      return;
    }
    if (target.datasetId !== browseDataset?.id) {
      target = createWidget("bar");
      if (!target) return;
    }
    const enc = target.encoding;
    // 分解树：文本列作为「说明依据」，数值列作为「分析」度量
    if (target.type === "decomposition" && col.type !== "number") {
      const fields = target.explainBy ?? [];
      if (!fields.includes(col.name)) {
        updateWidget(target.id, { explainBy: [...fields, col.name] });
      }
      return;
    }
    if (col.type === "number") {
      // 分解树只使用一个度量
      if (target.type === "decomposition") {
        updateWidget(target.id, {
          encoding: { ...enc, measures: [{ field: col.name, agg: "sum" }] },
        });
        return;
      }
      updateWidget(target.id, {
        encoding: { ...enc, measures: [...enc.measures, { field: col.name, agg: "sum" }] },
      });
      return;
    }
    if (!enc.dimension) {
      updateWidget(target.id, { encoding: { ...enc, dimension: col.name } });
    } else if (!enc.series) {
      updateWidget(target.id, { encoding: { ...enc, series: col.name } });
    } else {
      updateWidget(target.id, { encoding: { ...enc, dimension: col.name } });
    }
  }

  function handleSelectDataset(id: string) {
    setBrowseDatasetId(id);
    if (!selected || isDecoration(selected.type)) return;
    const ds = datasets.find((d) => d.id === id);
    if (!ds) return;
    // 字段留空，由用户自行拖拽
    updateWidget(selected.id, {
      datasetId: id,
      encoding: { measures: [] },
      ...(selected.type === "filter"
        ? { filterFields: [], slicer: defaultSlicer() }
        : {}),
      ...(selected.type === "decomposition"
        ? { explainBy: [], decomposition: defaultDecomposition() }
        : {}),
    });
  }

  /** 多选对齐 / 分布 / 等大 */
  function handleAlign(mode: AlignMode) {
    const picked = widgets.filter((w) => selectedIds.includes(w.id));
    if (picked.length < 2) return;
    const rects = alignRects(
      picked.map((w) => w.layout),
      mode,
    );
    picked.forEach((w, i) => updateWidget(w.id, { layout: rects[i] }));
  }

  function handleLayoutMany(items: Array<{ id: string; layout: WidgetLayout }>) {
    for (const it of items) updateWidget(it.id, { layout: it.layout });
  }

  function updatePage(patch: Partial<PageConfig>) {
    if (!active) return;
    updateDashboard(active.id, { page: { ...page, ...patch } });
  }

  /** 更新「此页上的筛选器」 */
  function updatePageFilters(next: FilterCondition[]) {
    if (!active) return;
    updateDashboard(active.id, { filters: next });
  }

  /** 切片器选择变化：同步切片器开启时，相同字段的切片器跨页联动 */
  function handleSlicerChange(id: string, slicer: SlicerConfig) {
    updateWidget(id, { slicer });
    if (syncSlicers) syncSlicerState(id, slicer);
  }

  const bookmarks = active?.bookmarks ?? [];

  /** 采集当前页面状态快照：筛选器、可见性 / Tab 顺序、切片器选择 */
  function captureState(): Bookmark["state"] {
    return {
      filters: active?.filters ?? [],
      widgets: (active?.widgets ?? []).map((w) => ({
        id: w.id,
        hidden: w.hidden,
        tabOrder: w.tabOrder,
      })),
      slicers: Object.fromEntries(
        (active?.widgets ?? [])
          .filter((w) => w.type === "filter")
          .map((w) => [w.id, slicerOf(w).state]),
      ),
    };
  }

  /** 添加书签：捕获当前页面的筛选器、隐藏状态与切片器选择 */
  function addBookmark() {
    if (!active) return;
    const bm: Bookmark = {
      id: uid("bm"),
      name: `书签 ${bookmarks.length + 1}`,
      state: captureState(),
    };
    updateDashboard(active.id, { bookmarks: [...bookmarks, bm] });
    toast.success(`已添加书签「${bm.name}」`);
  }

  /** 更新书签：用当前页面状态覆盖该书签保存的快照 */
  function updateBookmark(id: string) {
    if (!active) return;
    const bm = bookmarks.find((b) => b.id === id);
    if (!bm) return;
    updateDashboard(active.id, {
      bookmarks: bookmarks.map((b) => (b.id === id ? { ...b, state: captureState() } : b)),
    });
    toast.success(`已更新书签「${bm.name}」`);
  }

  function renameBookmark(id: string, name: string) {
    if (!active) return;
    const next = name.trim();
    if (!next) return;
    updateDashboard(active.id, {
      bookmarks: bookmarks.map((b) => (b.id === id ? { ...b, name: next } : b)),
    });
  }

  /** 应用书签：还原筛选器、可见性 / Tab 顺序与切片器选择（silent 为真时不弹提示） */
  function applyBookmark(id: string, silent = false) {
    if (!active) return;
    const bm = bookmarks.find((b) => b.id === id);
    if (!bm) return;
    for (const item of bm.state.widgets) {
      updateWidget(item.id, { hidden: item.hidden, tabOrder: item.tabOrder });
    }
    for (const w of active.widgets) {
      const state = bm.state.slicers[w.id];
      if (w.type === "filter" && state) {
        updateWidget(w.id, { slicer: { ...slicerOf(w), state } });
      }
    }
    updateDashboard(active.id, { filters: bm.state.filters });
    if (!silent) toast.success(`已应用书签「${bm.name}」`);
  }

  function deleteBookmark(id: string) {
    if (!active) return;
    updateDashboard(active.id, { bookmarks: bookmarks.filter((b) => b.id !== id) });
  }

  function handleRename() {
    if (!active) return;
    const name = renameValue.trim();
    if (!name) return;
    renameDashboard(active.id, name);
    setRenameOpen(false);
    window.alert("保存成功");
  }

  function enterPresent() {
    setSelectedIds([]);
    setHighlight(null);
    setPresenting(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function exitPresent() {
    setPresenting(false);
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
  }

  /** 报表页（编辑画布与演示共用）：尺寸、背景与背景图 */
  const pageStyle = {
    backgroundColor: page.background || "#ffffff",
    backgroundImage: page.backgroundImage ? `url("${page.backgroundImage}")` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  } as const;

  /** 右侧停靠面板总宽度：随筛选器 / 选择 / 书签窗格开关累加 */
  const paneWidth =
    480 + (filtersOpen ? 220 : 0) + (selectionOpen ? 240 : 0) + (bookmarksOpen ? 200 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Ribbon 菜单（Power BI 风格：Tab 条 + 图标在上文字在下的命令组） */}
      {!readOnly && (
        <div className="shrink-0 border-b bg-background">
          <div
            role="tablist"
            aria-label="功能区"
            className="flex h-9 items-end gap-1 border-b border-border bg-muted/50 px-3"
          >
            <RibbonTabButton active={ribbonTab === "home"} onClick={() => setRibbonTab("home")}>
              开始
            </RibbonTabButton>
            <RibbonTabButton
              active={ribbonTab === "insert"}
              onClick={() => setRibbonTab("insert")}
            >
              插入
            </RibbonTabButton>
            <RibbonTabButton active={ribbonTab === "view"} onClick={() => setRibbonTab("view")}>
              视图
            </RibbonTabButton>
          </div>

          <div role="tabpanel" className="flex min-h-[64px] flex-wrap items-stretch gap-2 px-2 py-1">
            {ribbonTab === "home" ? (
              <>
                <RibbonGroup label="插入">
                  <RibbonButton
                    Icon={Plus}
                    label="新建图表"
                    disabled={!active || datasets.length === 0}
                    onClick={() => handleCreate()}
                  />
                </RibbonGroup>
                <div className="mx-1 w-px self-stretch bg-border" />
                <RibbonGroup label="页面">
                  <RibbonButton Icon={Play} label="演示" disabled={!active} onClick={enterPresent} />
                  <RibbonButton
                    Icon={Settings2}
                    label="页面设置"
                    disabled={!active}
                    onClick={() => setPageOpen(true)}
                  />
                  <RibbonButton
                    Icon={Pencil}
                    label="重命名"
                    disabled={!active}
                    onClick={() => {
                      setRenameValue(active?.name ?? "");
                      setRenameOpen(true);
                    }}
                  />
                  <RibbonButton
                    Icon={Trash2}
                    label="删除页面"
                    disabled={!active || dashboards.length <= 1}
                    onClick={() => active && removeDashboard(active.id)}
                  />
                </RibbonGroup>
                <div className="mx-1 w-px self-stretch bg-border" />
                <RibbonGroup label="对齐">
                  <div className="grid grid-cols-5 gap-0.5">
                    {ALIGN_ACTIONS.map(({ mode, label, Icon }) => (
                      <button
                        key={mode}
                        type="button"
                        title={label}
                        aria-label={label}
                        disabled={selectedIds.length < 2}
                        onClick={() => handleAlign(mode)}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors",
                          selectedIds.length < 2
                            ? "cursor-not-allowed opacity-40"
                            : "hover:bg-accent hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                </RibbonGroup>
              </>
            ) : ribbonTab === "insert" ? (
              <>
                {/* 视觉对象：新建空白视觉对象 / 分解树（对齐 Power BI「插入」页签） */}
                <RibbonGroup label="视觉对象">
                  <RibbonButton
                    Icon={SquareDashed}
                    label="新建视觉对象"
                    disabled={!active}
                    onClick={() => handleCreate("bar")}
                  />
                  <RibbonButton
                    Icon={Workflow}
                    label="分解树"
                    disabled={!active}
                    onClick={() => handleCreate("decomposition")}
                  />
                </RibbonGroup>
                <div className="mx-1 w-px self-stretch bg-border" />
                {/* 元素：对齐 Power BI「插入 → 元素」的四个命令，图标在上、文字在下 */}
                <RibbonGroup label="元素">
                  <RibbonButton
                    Icon={Type}
                    label="文本框"
                    disabled={!active}
                    onClick={() => handleCreate("text")}
                  />
                  {/* 按钮：与 Power BI 一致，展开为动作类型清单（向左键 / 右箭头 / … / 导航器） */}
                  <RibbonDropdown
                    Icon={CHART_ICONS.button as unknown as typeof Plus}
                    label="按钮"
                    options={BUTTON_ACTIONS.map((a) => ({
                      value: a.key,
                      label: a.label,
                      Icon: a.Icon,
                    }))}
                    value=""
                    disabled={!active}
                    onChange={(v) => handleCreate("button", v as ButtonAction)}
                  />
                  {/* 形状：与 Power BI 一致，展开为分组图标网格（矩形 / 基本形状 / 箭头总汇） */}
                  <RibbonShapeMenu
                    disabled={!active}
                    onPick={(kind) => handleCreate("shape", undefined, kind)}
                  />
                  <RibbonButton
                    Icon={Image}
                    label="图像"
                    disabled={!active}
                    onClick={() => handleCreate("image")}
                  />
                </RibbonGroup>
              </>
            ) : (
              <>
                <RibbonGroup label="页面视图">
                  <RibbonDropdown
                    Icon={Maximize}
                    label="页面视图"
                    options={PAGE_FIT_OPTIONS}
                    value={pageFit}
                    disabled={!active}
                    onChange={(v) => updatePage({ pageFit: v as PageViewFit })}
                  />
                </RibbonGroup>
                <div className="mx-1 w-px self-stretch bg-border" />
                <RibbonGroup label="显示">
                  <div className="flex flex-col justify-center gap-0.5 py-0.5">
                    <RibbonCheck
                      label="网格线"
                      checked={!!page.gridlines}
                      disabled={!active}
                      onChange={(v) => updatePage({ gridlines: v })}
                    />
                    <RibbonCheck
                      label="锁定对象"
                      checked={!!page.lockObjects}
                      disabled={!active}
                      onChange={(v) => updatePage({ lockObjects: v })}
                    />
                    <RibbonCheck
                      label="同步切片器"
                      checked={syncSlicers}
                      disabled={!active}
                      onChange={(v) => setSyncSlicers(v)}
                    />
                  </div>
                </RibbonGroup>
                <div className="mx-1 w-px self-stretch bg-border" />
                <RibbonGroup label="窗格">
                  <RibbonButton
                    Icon={Filter}
                    label="筛选器"
                    active={filtersOpen}
                    onClick={() => setFiltersOpen((v) => !v)}
                  />
                  <RibbonButton
                    Icon={Layers}
                    label="选择"
                    active={selectionOpen}
                    onClick={() => setSelectionOpen((v) => !v)}
                  />
                  <RibbonButton
                    Icon={BookmarkIcon}
                    label="书签"
                    active={bookmarksOpen}
                    onClick={() => setBookmarksOpen((v) => !v)}
                  />
                </RibbonGroup>
              </>
            )}
          </div>
        </div>
      )}

      {/* 画布 + 右侧面板 */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 工作区：对比底色（壁纸）+ 报告页卡片（对齐 Power BI 报表页） */}
          <div
            ref={viewportRef}
            className="vbi-scroll min-h-0 min-w-0 flex-1 overflow-auto bg-muted/40 p-6"
            style={{ backgroundColor: page.wallpaper || undefined }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setSelectedIds([]);
                setHighlight(null);
              }
            }}
          >
            {/* 页面视图缩放：外层保留缩放后的占位尺寸，内层按 origin-top-left 缩放 */}
            <div className="mx-auto" style={{ width: baseW * zoom, height: baseH * zoom }}>
              <div
                className="relative origin-top-left rounded-md border shadow-sm"
                style={{
                  ...pageStyle,
                  width: baseW,
                  height: baseH,
                  transform: `scale(${zoom})`,
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    setSelectedIds([]);
                    setHighlight(null);
                  }
                }}
              >
                {/* 视图 → 网格线：编辑辅助网格，不参与指针事件 */}
                {page.gridlines ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-md"
                    style={{
                      backgroundImage:
                        "radial-gradient(circle, rgba(100, 116, 139, 0.38) 1px, transparent 1px)",
                      backgroundSize: "20px 20px",
                    }}
                  />
                ) : null}
                <ReportCanvas
                  widgets={widgets}
                  datasets={datasets}
                  selectedIds={selectedIds}
                  onSelect={handleSelect}
                  onLayout={(id, layout) => updateWidget(id, { layout })}
                  onLayoutMany={handleLayoutMany}
                  onRemove={(id) => {
                    setSelectedIds((prev) => prev.filter((x) => x !== id));
                    if (highlight?.sourceId === id) setHighlight(null);
                    removeWidget(id);
                  }}
                  highlight={highlight}
                  filters={activeValueFilters}
                  pageFilters={pageFilters}
                  reportFilters={reportFilters}
                  onPointClick={handlePointClick}
                  onDropVisual={readOnly ? undefined : handleDropVisual}
                  onSlicerChange={(id, slicer) => handleSlicerChange(id, slicer)}
                  onWidgetChange={(id, patch) => updateWidget(id, patch)}
                  onButtonAction={runButtonAction}
                  pageWidth={baseW}
                  pageHeight={baseH}
                  zoom={zoom}
                  readOnly={readOnly}
                  locked={!!page.lockObjects}
                />
              </div>
            </div>
          </div>

          {/* 页面导航：对齐 Power BI，把页面标签放在画布底部 */}
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t bg-muted/40 px-3 py-1">
            {dashboards.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setActive(d.id)}
                className={cn(
                  "shrink-0 rounded-t-md border-x border-t px-3 py-1 text-xs transition-colors",
                  d.id === activeId
                    ? "border-border bg-background font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {d.name}
              </button>
            ))}
            {!readOnly && (
              <button
                type="button"
                aria-label="新建仪表盘"
                title="新建页面"
                onClick={() => addDashboard(`仪表盘 ${dashboards.length + 1}`)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 右侧面板（Power BI 风格：筛选器 / 可视化 / 数据 / 选择 并列停靠） */}
        {!readOnly && (
          <aside
            className="flex shrink-0 border-l"
            style={{ width: paneWidth, maxWidth: "72vw" }}
          >
            {filtersOpen && (
              <FiltersPane
                reportFilters={reportFilters}
                pageFilters={pageFilters}
                visualFilters={selected?.filters ?? []}
                selectedWidget={selected}
                browseDatasetId={browseDataset?.id ?? null}
                datasets={datasets}
                onReportFiltersChange={setReportFilters}
                onPageFiltersChange={updatePageFilters}
                onVisualFiltersChange={(next) =>
                  selected && updateWidget(selected.id, { filters: next })
                }
                onClose={() => setFiltersOpen(false)}
                className="border-r"
              />
            )}
            <VisualizationsPane
              className="min-h-0 min-w-0 border-r"
              grow={1}
              widget={selected}
              dataset={selectedDataset}
              onChange={(patch) => selected && updateWidget(selected.id, patch)}
              onCreate={handleCreate}
              canCreate={datasets.length > 0}
            />
            <FieldsPane
              className="min-h-0 min-w-0"
              grow={1}
              datasets={datasets}
              datasetId={browseDataset?.id ?? null}
              onSelectDataset={handleSelectDataset}
              onPickField={handlePickField}
              onAddDataset={onAddDataset}
            />
            {selectionOpen && (
              <SelectionPane
                widgets={widgets}
                selectedIds={selectedIds}
                onSelect={handleSelect}
                onReorder={reorderWidgets}
                onToggleHidden={(id) => {
                  const target = widgets.find((w) => w.id === id);
                  if (!target) return;
                  updateWidget(id, { hidden: !target.hidden });
                  if (!target.hidden) {
                    setSelectedIds((prev) => prev.filter((x) => x !== id));
                  }
                }}
                onTabOrderChange={(items) => {
                  for (const it of items) updateWidget(it.id, { tabOrder: it.tabOrder });
                }}
                onClose={() => setSelectionOpen(false)}
              />
            )}
            {bookmarksOpen && (
              <BookmarksPane
                bookmarks={bookmarks}
                onAdd={addBookmark}
                onApply={applyBookmark}
                onUpdate={updateBookmark}
                onRename={renameBookmark}
                onDelete={deleteBookmark}
                onClose={() => setBookmarksOpen(false)}
              />
            )}
          </aside>
        )}
      </div>

      {/* 演示模式：全屏覆盖，仅保留可交互的报表页 */}
      {presenting ? (
        <div
          className="fixed inset-0 z-50 flex flex-col"
          style={{ backgroundColor: page.wallpaper || "#0f172a" }}
        >
          <div className="absolute right-3 top-3 z-20">
            <Button size="sm" variant="outline" onClick={exitPresent}>
              退出演示（Esc）
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div
              className={cn("mx-auto rounded-md shadow-lg", page.width > 0 ? "" : "w-full")}
              style={{
                ...pageStyle,
                width: page.width > 0 ? page.width : undefined,
                maxWidth: page.width > 0 ? undefined : 1400,
              }}
            >
              <ReportCanvas
                widgets={widgets}
                datasets={datasets}
                selectedIds={[]}
                onSelect={() => {}}
                onLayout={() => {}}
                onRemove={() => {}}
                highlight={highlight}
                filters={activeValueFilters}
                pageFilters={pageFilters}
                reportFilters={reportFilters}
                onPointClick={handlePointClick}
                onSlicerChange={(id, slicer) => handleSlicerChange(id, slicer)}
                onWidgetChange={(id, patch) => updateWidget(id, patch)}
                onButtonAction={runButtonAction}
                pageWidth={page.width}
                pageHeight={page.height}
                readOnly
              />
            </div>
          </div>
        </div>
      ) : null}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名仪表盘</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dash-name">名称</Label>
            <Input
              id="dash-name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button onClick={handleRename}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pageOpen} onOpenChange={setPageOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>页面设置</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="page-preset">画布尺寸</Label>
              <Select
                value={matchPreset(page)}
                onValueChange={(key) => {
                  const preset = PAGE_PRESETS.find((p) => p.key === key);
                  if (preset) updatePage({ width: preset.width, height: preset.height });
                }}
              >
                <SelectTrigger id="page-preset" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="page-w" className="text-xs text-muted-foreground">
                  宽度（0 = 适应容器）
                </Label>
                <Input
                  id="page-w"
                  type="number"
                  min={0}
                  value={page.width}
                  onChange={(e) =>
                    updatePage({ width: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="page-h" className="text-xs text-muted-foreground">
                  高度（0 = 随内容）
                </Label>
                <Input
                  id="page-h"
                  type="number"
                  min={0}
                  value={page.height}
                  onChange={(e) =>
                    updatePage({ height: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="page-bg" className="text-xs font-normal">
                  页面背景色
                </Label>
                <input
                  id="page-bg"
                  type="color"
                  value={page.background || "#ffffff"}
                  onChange={(e) => updatePage({ background: e.target.value })}
                  className="h-6 w-9 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="page-wallpaper" className="text-xs font-normal">
                  画布外壁纸色
                </Label>
                <input
                  id="page-wallpaper"
                  type="color"
                  value={page.wallpaper || "#f1f5f9"}
                  onChange={(e) => updatePage({ wallpaper: e.target.value })}
                  className="h-6 w-9 cursor-pointer rounded border border-border bg-transparent p-0"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="page-bg-image" className="text-xs text-muted-foreground">
                背景图片地址
              </Label>
              <Input
                id="page-bg-image"
                value={page.backgroundImage}
                onChange={(e) => updatePage({ backgroundImage: e.target.value })}
                placeholder="https://… （留空表示无背景图）"
                className="h-8 text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => updatePage({ wallpaper: "" })}>
              恢复默认壁纸
            </Button>
            <Button onClick={() => setPageOpen(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
