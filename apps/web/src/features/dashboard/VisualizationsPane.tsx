import { useState, type ReactNode } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  MoreHorizontal,
  Paintbrush,
  Plus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { CHART_ICONS } from "./chartIcons";
import { Button } from "@bi/components/ui/button";
import { Input } from "@bi/components/ui/input";
import { Label } from "@bi/components/ui/label";
import { Switch } from "@bi/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bi/components/ui/select";
import { cn } from "@bi/lib/utils";
import { AGG_LABELS, autoTitle, CHART_TYPE_LABELS, wellLabels } from "@bi/lib/chart";
import type {
  AggregateFn,
  ChartType,
  ChartWidget,
  Column,
  Dataset,
  MapRegion,
  Measure,
} from "@bi/types";

const CHART_TYPES = Object.keys(CHART_ICONS) as ChartType[];
const AGG_FNS = Object.keys(AGG_LABELS) as AggregateFn[];

type WellKind = "dimension" | "series" | "measure";
type PaneTab = "build" | "format";

interface VisualizationsPaneProps {
  widget: ChartWidget | null;
  dataset: Dataset | undefined;
  onChange: (patch: Partial<ChartWidget>) => void;
  /** 无选中图表时，点击图表类型以该类型新建 */
  onCreate: (type: ChartType) => void;
  canCreate: boolean;
  /** 展开时占据的 flex 比例（折叠后仅保留标题栏） */
  grow?: number;
  className?: string;
}

/** 右侧「可视化」窗格：页签 + 视觉对象类型画廊 + 字段井 + 格式（对齐 Power BI 可视化窗格） */
export function VisualizationsPane({
  widget,
  dataset,
  onChange,
  onCreate,
  canCreate,
  grow = 3,
  className,
}: VisualizationsPaneProps) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<PaneTab>("build");

  function setEncoding(patch: Partial<ChartWidget["encoding"]>) {
    if (!widget) return;
    onChange({ encoding: { ...widget.encoding, ...patch } });
  }

  function defaultAgg(field: string): AggregateFn {
    const col = dataset?.columns.find((c) => c.name === field);
    return col?.type === "number" ? "sum" : "count";
  }

  function addField(field: string, well: WellKind) {
    if (!widget) return;
    if (well === "dimension") setEncoding({ dimension: field });
    else if (well === "series") setEncoding({ series: field });
    else
      setEncoding({
        measures: [...widget.encoding.measures, { field, agg: defaultAgg(field) }],
      });
  }

  function updateMeasure(i: number, patch: Partial<Measure>) {
    setEncoding({
      measures: widget!.encoding.measures.map((m, idx) =>
        idx === i ? { ...m, ...patch } : m,
      ),
    });
  }

  function removeMeasure(i: number) {
    setEncoding({
      measures: widget!.encoding.measures.filter((_, idx) => idx !== i),
    });
  }

  const columns: Column[] = dataset?.columns ?? [];
  const labels = wellLabels(widget?.type ?? "bar");

  return (
    <div
      className={cn("flex min-h-0 flex-col", className)}
      style={{ flex: open ? `${grow} 1 0%` : "0 0 auto" }}
    >
      {/* 窗格标题栏（Power BI：标题在左、折叠箭头在右） */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <span className="flex-1 text-sm font-semibold">可视化</span>
        <button
          type="button"
          aria-label={open ? "折叠" : "展开"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          {open ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {open ? (
        <>
          {/* 生成 / 格式页签（Power BI 视觉对象窗格顶部） */}
          <div className="shrink-0 px-2 pt-2">
            <div className="pb-1.5 text-xs font-semibold text-foreground">
              {tab === "build" ? "生成视觉对象" : "设置视觉对象格式"}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="生成视觉对象"
                aria-label="生成视觉对象"
                aria-pressed={tab === "build"}
                onClick={() => setTab("build")}
                className={cn(
                  "flex h-7 w-9 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  tab === "build" && "bg-muted text-foreground",
                )}
              >
                <BarChart3 className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="设置视觉对象格式"
                aria-label="设置视觉对象格式"
                aria-pressed={tab === "format"}
                onClick={() => setTab("format")}
                className={cn(
                  "flex h-7 w-9 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  tab === "format" && "bg-muted text-foreground",
                )}
              >
                <Paintbrush className="h-4 w-4" />
              </button>
            </div>
          </div>

          {tab === "build" ? (
            <div className="mt-2 min-h-0 flex-1 overflow-auto">
              {/* 视觉对象类型画廊：Power BI 的图标网格（带边框、可滚动） */}
              <div className="border-y p-2">
                <div className="max-h-[184px] overflow-y-auto rounded-md border bg-card p-1.5">
                  <div className="grid grid-cols-6 gap-1">
                    {CHART_TYPES.map((t) => {
                      const Icon = CHART_ICONS[t];
                      const active = widget?.type === t;
                      const disabled = !widget && !canCreate;
                      return (
                        <button
                          key={t}
                          type="button"
                          title={CHART_TYPE_LABELS[t]}
                          aria-label={CHART_TYPE_LABELS[t]}
                          aria-pressed={active}
                          disabled={disabled}
                          onClick={() =>
                            widget ? onChange({ type: t }) : onCreate(t)
                          }
                          className={cn(
                            "flex h-8 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground",
                            active && "border-primary/50 bg-primary/10 text-primary",
                            disabled &&
                              "cursor-not-allowed opacity-40 hover:border-transparent hover:bg-transparent hover:text-muted-foreground",
                          )}
                        >
                          <Icon className="h-5 w-5" />
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      title="更多视觉对象"
                      aria-label="更多视觉对象"
                      onClick={() =>
                        toast("更多视觉对象即将支持", {
                          description: "后续将接入更多图表类型。",
                        })
                      }
                      className="flex h-8 items-center justify-center rounded border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
                    >
                      <MoreHorizontal className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* 字段：字段井（按图表类型命名，顺序对齐 Power BI：轴 → 值 → 图例） */}
              <div className="p-3">
                <div className="mb-2 text-xs font-semibold text-foreground">字段</div>
                {!widget ? (
                  <p className="text-xs text-muted-foreground">
                    {canCreate
                      ? "选择一种图表类型以新建可视化，或点击画布中的图表进行编辑。"
                      : "请先点击「数据」窗格的 ＋ 添加数据集。"}
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    <Well
                      title={labels.dimension}
                      placeholder="将字段拖到此处"
                      field={widget.encoding.dimension}
                      onDropField={(f) => addField(f, "dimension")}
                      onClear={() => setEncoding({ dimension: undefined })}
                    />
                    <Well
                      title={labels.measures}
                      placeholder="将字段拖到此处，或点击字段添加"
                      empty={widget.encoding.measures.length === 0}
                      onDropField={(f) => addField(f, "measure")}
                    >
                      {widget.encoding.measures.map((m, i) => (
                        <div
                          key={`${m.field}-${i}`}
                          className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs"
                        >
                          <Select
                            value={m.agg}
                            onValueChange={(agg) =>
                              updateMeasure(i, { agg: agg as AggregateFn })
                            }
                          >
                            <SelectTrigger className="h-6 w-20 border-0 bg-transparent px-1.5 text-xs shadow-none">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {AGG_FNS.map((a) => (
                                <SelectItem key={a} value={a} className="text-xs">
                                  {AGG_LABELS[a]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={m.field}
                            onValueChange={(field) => updateMeasure(i, { field })}
                          >
                            <SelectTrigger className="h-6 flex-1 border-0 bg-transparent px-1.5 text-xs shadow-none">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {columns.map((c) => (
                                <SelectItem key={c.name} value={c.name} className="text-xs">
                                  {c.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            aria-label="移除度量"
                            onClick={() => removeMeasure(i)}
                            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </Well>
                    <Well
                      title={labels.series}
                      placeholder="将字段拖到此处（可选）"
                      field={widget.encoding.series}
                      onDropField={(f) => addField(f, "series")}
                      onClear={() => setEncoding({ series: undefined })}
                    />

                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-full justify-start px-1 text-xs text-muted-foreground hover:text-foreground"
                      disabled={columns.length === 0}
                      onClick={() => columns[0] && addField(columns[0].name, "measure")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      添加度量
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 min-h-0 flex-1 overflow-auto p-3">
              <FormatSection widget={widget} onChange={onChange} />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/** 「格式」分区：视觉对象外观设置（对齐 Power BI 的格式窗格：可折叠分组列表） */
function FormatSection({
  widget,
  onChange,
}: {
  widget: ChartWidget | null;
  onChange: (patch: Partial<ChartWidget>) => void;
}) {
  if (!widget) {
    return (
      <p className="text-xs text-muted-foreground">
        请选择画布中的视觉对象以设置格式。
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <FormatGroup title="标题" defaultOpen>
        <ToggleRow
          id="fmt-title"
          label="显示标题"
          checked={widget.showTitle ?? true}
          onChange={(checked) => onChange({ showTitle: checked })}
        />
        <div className="space-y-1 pt-1">
          <Label htmlFor="fmt-title-text" className="text-xs text-muted-foreground">
            标题文本
          </Label>
          <Input
            id="fmt-title-text"
            value={widget.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={autoTitle(widget.encoding) || "留空则按字段自动生成"}
            className="h-7 text-xs"
          />
        </div>
      </FormatGroup>
      <FormatGroup title="图例" defaultOpen>
        <ToggleRow
          id="fmt-legend"
          label="显示图例"
          checked={widget.showLegend ?? true}
          onChange={(checked) => onChange({ showLegend: checked })}
          disabled={
            widget.type === "table" ||
            widget.type === "kpi" ||
            widget.type === "treemap" ||
            widget.type === "funnel"
          }
        />
      </FormatGroup>
      {widget.type === "map" ? (
        <FormatGroup title="地图" defaultOpen>
          <div className="space-y-1 pt-1">
            <Label
              htmlFor="fmt-map-region"
              className="text-xs text-muted-foreground"
            >
              地图区域
            </Label>
            <Select
              value={widget.mapRegion ?? "auto"}
              onValueChange={(v) => onChange({ mapRegion: v as MapRegion })}
            >
              <SelectTrigger id="fmt-map-region" className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">
                  自动
                </SelectItem>
                <SelectItem value="china" className="text-xs">
                  中国
                </SelectItem>
                <SelectItem value="world" className="text-xs">
                  世界
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FormatGroup>
      ) : null}
      {widget.type === "matrix" ? (
        <FormatGroup title="数据透视表" defaultOpen>
          <ToggleRow
            id="fmt-matrix-totals"
            label="显示行列总计"
            checked={widget.showTotals ?? true}
            onChange={(checked) => onChange({ showTotals: checked })}
          />
        </FormatGroup>
      ) : null}
    </div>
  );
}

/** 可折叠的格式分组（对齐 Power BI 格式窗格的折叠卡片） */
function FormatGroup({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-accent/60"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="flex-1">{title}</span>
      </button>
      {open ? (
        <div className="space-y-1 border-t px-2.5 py-2">{children}</div>
      ) : null}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

interface WellProps {
  title: string;
  placeholder?: string;
  field?: string;
  children?: ReactNode;
  empty?: boolean;
  onDropField: (field: string) => void;
  onClear?: () => void;
}

/** 字段槽位：井名 + 拖放区（对齐 Power BI 的字段井：极简、无重边框） */
function Well({
  title,
  placeholder,
  field,
  children,
  empty,
  onDropField,
  onClear,
}: WellProps) {
  const [over, setOver] = useState(false);
  const isEmpty = empty ?? !field;

  return (
    <div className="space-y-1">
      <div className="px-0.5 text-xs text-muted-foreground">{title}</div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f =
            e.dataTransfer.getData("application/x-bi-field") ||
            e.dataTransfer.getData("text/plain") ||
            e.dataTransfer.getData("text");
          if (f) onDropField(f);
        }}
        className={cn(
          "min-h-[30px] space-y-1 rounded border border-dashed p-1.5 transition-colors",
          over ? "border-primary bg-primary/5" : "border-border bg-muted/30",
        )}
      >
        {children}
        {field ? (
          <div className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs">
            <span className="flex-1 truncate">{field}</span>
            <button
              type="button"
              aria-label="移除字段"
              onClick={onClear}
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        {isEmpty ? (
          <p className="px-0.5 py-1 text-[11px] text-muted-foreground">
            {placeholder ?? "将字段拖到此处"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
