import { useEffect, useState } from "react";
import { LayoutDashboard, Pencil, Plus, Trash2 } from "lucide-react";
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
import { ReportCanvas } from "./ReportCanvas";
import { FieldsPane } from "./FieldsPane";
import { VisualizationsPane } from "./VisualizationsPane";
import { useDashboardStore } from "@bi/stores/dashboardStore";
import { useDatasetStore } from "@bi/stores/datasetStore";
import { cn } from "@bi/lib/utils";
import { uid } from "@bi/lib/utils";
import type { ChartType, ChartWidget, Column } from "@bi/types";
import { toggleSelection, type HighlightSelection } from "@bi/lib/highlight";

/** 新建视觉对象的默认像素尺寸与级联偏移 */
const DEFAULT_WIDGET_W = 420;
const DEFAULT_WIDGET_H = 280;
const CASCADE_STEP = 28;
const PAGE_MARGIN = 24;

export function DashboardView({
  onAddDataset,
  readOnly = false,
}: { onAddDataset?: () => void; readOnly?: boolean } = {}) {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);
  const addDashboard = useDashboardStore((s) => s.addDashboard);
  const renameDashboard = useDashboardStore((s) => s.renameDashboard);
  const removeDashboard = useDashboardStore((s) => s.removeDashboard);
  const addWidget = useDashboardStore((s) => s.addWidget);
  const updateWidget = useDashboardStore((s) => s.updateWidget);
  const removeWidget = useDashboardStore((s) => s.removeWidget);

  const datasets = useDatasetStore((s) => s.datasets);

  const active = dashboards.find((d) => d.id === activeId) ?? dashboards[0];
  const widgets = active?.widgets ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 交叉高亮为瞬时态：不写入 .biproj，切换仪表盘/点击空白/Esc 时清空 */
  const [highlight, setHighlight] = useState<HighlightSelection | null>(null);
  const [browseDatasetId, setBrowseDatasetId] = useState<string>("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const selected = widgets.find((w) => w.id === selectedId) ?? null;
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
    setSelectedId(null);
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
    const ds = browseDataset ?? datasets[0];
    if (!ds) return null;
    // 级联摆放，避免新视觉对象完全重叠
    const step = (widgets.length % 5) * CASCADE_STEP;
    const widget: ChartWidget = {
      id: uid("w"),
      type,
      // 标题留空 → 画布按字段自动生成（Power BI 风格），不使用数据源名称
      title: "",
      datasetId: ds.id,
      // 字段留空，由用户自行拖拽
      encoding: { measures: [] },
      layout: {
        x: PAGE_MARGIN + step,
        y: PAGE_MARGIN + step,
        w: DEFAULT_WIDGET_W,
        h: DEFAULT_WIDGET_H,
      },
    };
    addWidget(widget);
    setSelectedId(widget.id);
    return widget;
  }

  function handleCreate(type: ChartType = "bar") {
    if (!createWidget(type)) {
      toast.error("请先在左侧「数据」标签中添加数据集");
      return;
    }
    toast.success("已新建图表，可在右侧拖入字段");
  }

  /** 数据面板点击字段：数值列进度量，文本列优先作维度/系列 */
  function handlePickField(col: Column) {
    let target = selected;
    if (!target || target.datasetId !== browseDataset?.id) {
      target = createWidget();
      if (!target) return;
    }
    const enc = target.encoding;
    if (col.type === "number") {
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
    if (!selected) return;
    const ds = datasets.find((d) => d.id === id);
    if (!ds) return;
    // 字段留空，由用户自行拖拽
    updateWidget(selected.id, { datasetId: id, encoding: { measures: [] } });
  }

  function handleRename() {
    if (!active) return;
    const name = renameValue.trim();
    if (!name) return;
    renameDashboard(active.id, name);
    setRenameOpen(false);
    window.alert("保存成功");
  }

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

        {!readOnly && (
          <>
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
        {/* 工作区：对比底色 + 报告页卡片（对齐 Power BI 报表页） */}
        <div
          className="min-h-0 flex-1 overflow-auto bg-muted/40 p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedId(null);
              setHighlight(null);
            }
          }}
        >
          <div
            className="mx-auto min-h-full max-w-[1400px] rounded-md border bg-card p-4 shadow-sm"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setSelectedId(null);
                setHighlight(null);
              }
            }}
          >
            <ReportCanvas
              widgets={widgets}
              datasets={datasets}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                if (!id) setHighlight(null);
              }}
              onLayout={(id, layout) => updateWidget(id, { layout })}
              onRemove={(id) => {
                if (selectedId === id) setSelectedId(null);
                if (highlight?.sourceId === id) setHighlight(null);
                removeWidget(id);
              }}
              highlight={highlight}
              onPointClick={handlePointClick}
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
    </div>
  );
}
