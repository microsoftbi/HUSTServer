import { useEffect, useMemo, useState } from "react";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceAround,
  LayoutDashboard,
  Pencil,
  Play,
  Plus,
  Settings2,
  StretchHorizontal,
  StretchVertical,
  Trash2,
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
import { ReportCanvas } from "./ReportCanvas";
import { FieldsPane } from "./FieldsPane";
import { VisualizationsPane } from "./VisualizationsPane";
import { useDashboardStore } from "@bi/stores/dashboardStore";
import { useDatasetStore } from "@bi/stores/datasetStore";
import { cn } from "@bi/lib/utils";
import { uid } from "@bi/lib/utils";
import type {
  ChartType,
  ChartWidget,
  Column,
  PageConfig,
  WidgetLayout,
} from "@bi/types";
import { toggleSelection, type HighlightSelection, type ValueFilter } from "@bi/lib/highlight";
import { defaultSlicer, slicerFilters, slicerOf } from "@bi/lib/slicer";
import { defaultDecomposition } from "@bi/lib/decomposition";
import { alignRects, type AlignMode } from "@bi/lib/canvas";
import { DEFAULT_WIDGET_STYLE, PAGE_PRESETS, matchPreset, pageOf } from "@bi/lib/style";
import { DEFAULT_DECORATION, defaultDecoration, isDecoration } from "@bi/lib/decoration";

/** 新建视觉对象的默认像素尺寸与级联偏移 */
const DEFAULT_WIDGET_W = 420;
const DEFAULT_WIDGET_H = 280;
/** 切片器视觉对象的默认尺寸（扁平条状，便于并列摆放） */
const FILTER_WIDGET_W = 260;
const FILTER_WIDGET_H = 200;
const CASCADE_STEP = 28;
const PAGE_MARGIN = 24;

/** 装饰元素的默认尺寸（文本框扁平、图像与形状偏方） */
const DECOR_SIZE: Record<string, { w: number; h: number }> = {
  text: { w: 320, h: 80 },
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

  function createWidget(type: ChartType = "bar"): ChartWidget | null {
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
            decoration: type === "text" ? defaultDecoration(type) : { ...DEFAULT_DECORATION },
          }
        : {}),
    };
    addWidget(widget);
    setSelectedIds([widget.id]);
    return widget;
  }

  const DECOR_LABELS: Partial<Record<ChartType, string>> = {
    text: "文本框",
    image: "图像",
    shape: "形状",
  };

  function handleCreate(type: ChartType = "bar") {
    const widget = createWidget(type);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {dashboards.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setActive(d.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent",
                d.id === activeId ? "bg-accent font-medium" : "text-muted-foreground",
              )}
            >
              {d.name}
            </button>
          ))}
          {!readOnly && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="新建仪表盘"
              onClick={() => addDashboard(`仪表盘 ${dashboards.length + 1}`)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* 多选时浮出对齐工具条（对齐 Power BI 的「格式 → 对齐」） */}
        {!readOnly && selectedIds.length >= 2 && (
          <div className="flex items-center gap-0.5 rounded-md border px-1 py-0.5">
            <span className="px-1 text-xs text-muted-foreground">
              已选 {selectedIds.length} 个
            </span>
            {ALIGN_ACTIONS.map(({ mode, label, Icon }) => (
              <button
                key={mode}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => handleAlign(mode)}
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          disabled={!active}
          onClick={enterPresent}
          title="全屏演示当前页"
        >
          <Play className="h-4 w-4" />
          演示
        </Button>

        {!readOnly && (
          <>
            <Button size="sm" variant="outline" disabled={!active} onClick={() => setPageOpen(true)}>
              <Settings2 className="h-4 w-4" />
              页面
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!active}
              onClick={() => {
                setRenameValue(active?.name ?? "");
                setRenameOpen(true);
              }}
            >
              <Pencil className="h-4 w-4" />
              重命名
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!active || dashboards.length <= 1}
              onClick={() => active && removeDashboard(active.id)}
            >
              <Trash2 className="h-4 w-4" />
              删除
            </Button>
            <Button size="sm" onClick={() => handleCreate()} disabled={datasets.length === 0}>
              <Plus className="h-4 w-4" />
              新建图表
            </Button>
          </>
        )}
      </div>

      {/* 画布 + 右侧面板 */}
      <div className="flex min-h-0 flex-1">
        {/* 工作区：对比底色（壁纸）+ 报告页卡片（对齐 Power BI 报表页） */}
        <div
          className="min-h-0 flex-1 overflow-auto bg-muted/40 p-6"
          style={{ backgroundColor: page.wallpaper || undefined }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedIds([]);
              setHighlight(null);
            }
          }}
        >
          <div
            className={cn(
              "mx-auto min-h-full rounded-md border shadow-sm",
              page.width > 0 ? "" : "w-full max-w-[1400px]",
            )}
            style={{ ...pageStyle, width: page.width > 0 ? page.width : undefined }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setSelectedIds([]);
                setHighlight(null);
              }
            }}
          >
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
              onPointClick={handlePointClick}
              onDropVisual={readOnly ? undefined : handleDropVisual}
              onSlicerChange={(id, slicer) => updateWidget(id, { slicer })}
              onWidgetChange={(id, patch) => updateWidget(id, patch)}
              pageWidth={page.width}
              pageHeight={page.height}
              readOnly={readOnly}
            />
          </div>
        </div>

        {/* 右侧面板（Power BI 风格：可视化 / 数据 两列并排） */}
        {!readOnly && (
          <aside className="flex w-[480px] shrink-0 border-l">
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
                onPointClick={handlePointClick}
                onSlicerChange={(id, slicer) => updateWidget(id, { slicer })}
                onWidgetChange={(id, patch) => updateWidget(id, patch)}
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
