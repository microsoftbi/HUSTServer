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
import { Textarea } from "@bi/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bi/components/ui/select";
import { cn } from "@bi/lib/utils";
import { AGG_LABELS, autoTitle, CHART_TYPE_LABELS, wellLabels } from "@bi/lib/chart";
import {
  SLICER_TYPE_LABELS,
  slicerOf,
} from "@bi/lib/slicer";
import { treemapOf } from "@bi/lib/treemap";
import { decompositionOf } from "@bi/lib/decomposition";
import { BUTTON_ACTIONS, isDecoration } from "@bi/lib/decoration";
import { decorationOf } from "@bi/lib/decoration";
import { SHAPE_GROUPS } from "@bi/lib/shapes";
import { DEFAULT_WIDGET_STYLE, styleOf } from "@bi/lib/style";
import type {
  AggregateFn,
  ButtonAction,
  ChartType,
  ChartWidget,
  Column,
  Dataset,
  DecorationConfig,
  DecompositionConfig,
  MapRegion,
  Measure,
  SlicerConfig,
  SlicerSelectionMode,
  SlicerType,
  TreemapColorMode,
  TreemapConfig,
  WidgetShadow,
  WidgetStyle,
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
    else if (widget.type === "decomposition")
      // 分解树只使用一个度量（与 Power BI 一致）
      setEncoding({ measures: [{ field, agg: defaultAgg(field) }] });
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

  function addFilterField(field: string) {
    if (!widget) return;
    const fields = widget.filterFields ?? [];
    if (fields.includes(field)) return;
    const next = [...fields, field];
    const cfg = slicerOf(widget);
    // 与 Power BI 一致：拖入第二个字段时自动切换为层次结构切片器
    const autoHierarchy =
      next.length > 1 && (cfg.type === "list" || cfg.type === "dropdown");
    onChange({
      filterFields: next,
      ...(autoHierarchy ? { slicer: { ...cfg, type: "hierarchy" } } : {}),
    });
  }

  function removeFilterField(field: string) {
    if (!widget) return;
    const next = (widget.filterFields ?? []).filter((f) => f !== field);
    const cfg = slicerOf(widget);
    // 层次结构只剩一个字段时回落到列表切片器
    const backToList = next.length <= 1 && cfg.type === "hierarchy";
    onChange({
      filterFields: next,
      ...(backToList ? { slicer: { ...cfg, type: "list" } } : {}),
    });
  }

  /** 分解树：追加 / 移除「说明依据」字段 */
  function addExplainField(field: string) {
    if (!widget) return;
    const fields = widget.explainBy ?? [];
    if (fields.includes(field)) return;
    onChange({ explainBy: [...fields, field] });
  }

  function removeExplainField(field: string) {
    if (!widget) return;
    onChange({ explainBy: (widget.explainBy ?? []).filter((f) => f !== field) });
  }

  const columns: Column[] = dataset?.columns ?? [];
  const labels = wellLabels(widget?.type ?? "bar");
  const isDecomp = widget?.type === "decomposition";

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
                      const isFilter = t === "filter";
                      // 装饰元素不依赖数据集，始终可新建
                      const isDecor = isDecoration(t);
                      const disabled = !widget && !canCreate && !isDecor;
                      return (
                        <button
                          key={t}
                          type="button"
                          title={
                            isFilter
                              ? "切片器（拖到画布）"
                              : isDecor
                                ? `${CHART_TYPE_LABELS[t]}（拖到画布）`
                                : CHART_TYPE_LABELS[t]
                          }
                          aria-label={CHART_TYPE_LABELS[t]}
                          aria-pressed={active}
                          disabled={disabled}
                          draggable={(isFilter || isDecor) && canCreate}
                          onDragStart={(e) => {
                            if (!isFilter && !isDecor) return;
                            e.dataTransfer.setData("application/x-bi-visual", t);
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          onClick={() => {
                            // 切片器 / 装饰元素始终新建，避免把已有图表改造掉
                            if (isFilter || isDecor || !widget) onCreate(t);
                            else onChange({ type: t });
                          }}
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
                      : "请先在左侧「数据」标签中添加数据集。"}
                  </p>
                ) : isDecoration(widget.type) ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    装饰元素不绑定数据字段，在「设置视觉对象格式」中调整内容与外观。
                  </p>
                ) : widget.type === "filter" ? (
                  <div className="space-y-2.5">
                    <Well
                      title="筛选字段"
                      placeholder="将字段拖到此处，或点击数据窗格中的字段添加"
                      empty={(widget.filterFields ?? []).length === 0}
                      onDropField={addFilterField}
                    >
                      {(widget.filterFields ?? []).map((f) => (
                        <div
                          key={f}
                          className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs"
                        >
                          <span className="flex-1 truncate">{f}</span>
                          <button
                            type="button"
                            aria-label="移除筛选字段"
                            onClick={() => removeFilterField(f)}
                            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </Well>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      拖入一个字段即为列表/下拉切片器；拖入多个字段可切换为「层次结构」。
                      选中值后立即过滤本页所有图表。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {isDecomp ? (
                      <Well
                        title="说明依据"
                        placeholder="将维度字段拖到此处，可添加多个"
                        empty={(widget.explainBy ?? []).length === 0}
                        onDropField={addExplainField}
                      >
                        {(widget.explainBy ?? []).map((f) => (
                          <div
                            key={f}
                            className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs"
                          >
                            <span className="flex-1 truncate">{f}</span>
                            <button
                              type="button"
                              aria-label="移除说明依据"
                              onClick={() => removeExplainField(f)}
                              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </Well>
                    ) : (
                      <Well
                        title={labels.dimension}
                        placeholder="将字段拖到此处"
                        field={widget.encoding.dimension}
                        onDropField={(f) => addField(f, "dimension")}
                        onClear={() => setEncoding({ dimension: undefined })}
                      />
                    )}
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
                    {isDecomp ? null : (
                      <Well
                        title={labels.series}
                        placeholder="将字段拖到此处（可选）"
                        field={widget.encoding.series}
                        onDropField={(f) => addField(f, "series")}
                        onClear={() => setEncoding({ series: undefined })}
                      />
                    )}

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
                    {isDecomp ? (
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        数值列作为「分析」度量，维度列作为「说明依据」。点击节点上的 + 选择拆分字段，
                        展开状态会随视觉对象保存。
                      </p>
                    ) : null}
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

  if (widget.type === "filter") {
    return <SlicerFormat widget={widget} onChange={onChange} />;
  }

  const isDecor = isDecoration(widget.type);
  const st = styleOf(widget);
  const setStyle = (patch: Partial<WidgetStyle>) =>
    onChange({ style: { ...st, ...patch } });
  const deco = decorationOf(widget);
  const setDeco = (patch: Partial<DecorationConfig>) =>
    onChange({ decoration: { ...deco, ...patch } });

  return (
    <div className="space-y-1.5">
      {!isDecor ? (
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
          <NumberRow
            id="fmt-title-size"
            label="字号"
            min={8}
            max={32}
            value={st.titleFontSize}
            onChange={(v) => setStyle({ titleFontSize: v })}
          />
          <ColorRow
            id="fmt-title-color"
            label="颜色"
            value={st.titleColor}
            onChange={(v) => setStyle({ titleColor: v })}
          />
          <div className="flex items-center justify-between py-1">
            <Label htmlFor="fmt-title-align" className="text-xs font-normal">
              对齐
            </Label>
            <Select
              value={st.titleAlign}
              onValueChange={(v) =>
                setStyle({ titleAlign: v as WidgetStyle["titleAlign"] })
              }
            >
              <SelectTrigger id="fmt-title-align" className="h-6 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="left" className="text-xs">
                  左
                </SelectItem>
                <SelectItem value="center" className="text-xs">
                  中
                </SelectItem>
                <SelectItem value="right" className="text-xs">
                  右
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FormatGroup>
      ) : null}

      {widget.type === "text" || widget.type === "button" ? (
        <FormatGroup title="文本" defaultOpen>
          <div className="space-y-1 pb-1">
            <Label htmlFor="fmt-decor-text" className="text-xs text-muted-foreground">
              内容
            </Label>
            <Textarea
              id="fmt-decor-text"
              value={deco.text}
              onChange={(e) => setDeco({ text: e.target.value })}
              rows={3}
              className="text-xs"
            />
          </div>
          <NumberRow
            id="fmt-decor-font"
            label="字号"
            min={8}
            max={72}
            value={deco.fontSize}
            onChange={(v) => setDeco({ fontSize: v })}
          />
          <ToggleRow
            id="fmt-decor-bold"
            label="加粗"
            checked={deco.bold}
            onChange={(v) => setDeco({ bold: v })}
          />
          <ColorRow
            id="fmt-decor-color"
            label="颜色"
            value={deco.color}
            onChange={(v) => setDeco({ color: v })}
          />
          <SelectRow
            id="fmt-decor-align"
            label="水平对齐"
            value={deco.align}
            options={[
              { value: "left", label: "左" },
              { value: "center", label: "中" },
              { value: "right", label: "右" },
            ]}
            onChange={(v) => setDeco({ align: v as WidgetStyle["titleAlign"] })}
          />
          <SelectRow
            id="fmt-decor-valign"
            label="垂直对齐"
            value={deco.verticalAlign}
            options={[
              { value: "top", label: "上" },
              { value: "middle", label: "中" },
              { value: "bottom", label: "下" },
            ]}
            onChange={(v) =>
              setDeco({ verticalAlign: v as DecorationConfig["verticalAlign"] })
            }
          />
        </FormatGroup>
      ) : null}

      {widget.type === "image" ? (
        <FormatGroup title="图像" defaultOpen>
          <div className="space-y-1 pb-1">
            <Label htmlFor="fmt-decor-image" className="text-xs text-muted-foreground">
              图片地址
            </Label>
            <Input
              id="fmt-decor-image"
              value={deco.imageUrl}
              onChange={(e) => setDeco({ imageUrl: e.target.value })}
              placeholder="https://… 或 data:image/…"
              className="h-7 text-xs"
            />
          </div>
          <SelectRow
            id="fmt-decor-fit"
            label="填充方式"
            value={deco.imageFit}
            options={[
              { value: "contain", label: "适应" },
              { value: "cover", label: "填充" },
              { value: "fill", label: "拉伸" },
            ]}
            onChange={(v) =>
              setDeco({ imageFit: v as DecorationConfig["imageFit"] })
            }
          />
        </FormatGroup>
      ) : null}

      {widget.type === "shape" || widget.type === "button" ? (
        <FormatGroup title={widget.type === "button" ? "按钮" : "形状"} defaultOpen>
          {widget.type === "button" ? (
            <SelectRow
              id="fmt-decor-action"
              label="动作"
              value={deco.action}
              options={BUTTON_ACTIONS.map((a) => ({ value: a.key, label: a.label }))}
              onChange={(v) => setDeco({ action: v as ButtonAction })}
            />
          ) : null}
          {widget.type === "shape" ? (
            <SelectRow
              id="fmt-decor-shape"
              label="形状"
              value={deco.shape}
              options={SHAPE_GROUPS.flatMap((g) =>
                g.items.map((i) => ({ value: i.key, label: `${g.label} / ${i.label}` })),
              )}
              onChange={(v) => setDeco({ shape: v as DecorationConfig["shape"] })}
            />
          ) : null}
          {deco.shape !== "line" ? (
            <ColorRow
              id="fmt-decor-fill"
              label="填充颜色"
              value={deco.fill}
              onChange={(v) => setDeco({ fill: v })}
              clearable
            />
          ) : null}
          <ColorRow
            id="fmt-decor-stroke"
            label="边框颜色"
            value={deco.stroke}
            onChange={(v) => setDeco({ stroke: v })}
          />
          <NumberRow
            id="fmt-decor-stroke-w"
            label="边框宽度"
            min={0}
            max={12}
            value={deco.strokeWidth}
            onChange={(v) => setDeco({ strokeWidth: v })}
          />
          {deco.shape === "rect" ? (
            <NumberRow
              id="fmt-decor-radius"
              label="圆角"
              min={0}
              max={64}
              value={deco.radius}
              onChange={(v) => setDeco({ radius: v })}
            />
          ) : null}
        </FormatGroup>
      ) : null}

      <FormatGroup title="常规" defaultOpen={isDecor}>
        <ColorRow
          id="fmt-bg"
          label="背景色"
          value={st.background}
          onChange={(v) => setStyle({ background: v })}
          clearable
          fallback="#ffffff"
        />
        <NumberRow
          id="fmt-bg-opacity"
          label="背景不透明度"
          min={0}
          max={100}
          value={st.backgroundOpacity}
          onChange={(v) => setStyle({ backgroundOpacity: v })}
        />
        <NumberRow
          id="fmt-padding"
          label="内边距"
          min={0}
          max={48}
          value={st.padding}
          onChange={(v) => setStyle({ padding: v })}
        />
      </FormatGroup>

      <FormatGroup title="效果">
        <ColorRow
          id="fmt-border"
          label="边框颜色"
          value={st.borderColor}
          onChange={(v) => setStyle({ borderColor: v })}
        />
        <NumberRow
          id="fmt-border-w"
          label="边框宽度"
          min={0}
          max={12}
          value={st.borderWidth}
          onChange={(v) => setStyle({ borderWidth: v })}
        />
        <NumberRow
          id="fmt-radius"
          label="圆角"
          min={0}
          max={48}
          value={st.borderRadius}
          onChange={(v) => setStyle({ borderRadius: v })}
        />
        <SelectRow
          id="fmt-shadow"
          label="阴影"
          value={st.shadow}
          options={[
            { value: "none", label: "无" },
            { value: "sm", label: "小" },
            { value: "md", label: "中" },
            { value: "lg", label: "大" },
          ]}
          onChange={(v) => setStyle({ shadow: v as WidgetShadow })}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full justify-start px-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => onChange({ style: { ...DEFAULT_WIDGET_STYLE } })}
        >
          恢复默认外观
        </Button>
      </FormatGroup>

      {!isDecor ? (
        <FormatGroup title="图例" defaultOpen>
          <ToggleRow
            id="fmt-legend"
            label="显示图例"
            checked={widget.showLegend ?? true}
            onChange={(checked) => onChange({ showLegend: checked })}
            disabled={
              widget.type === "table" ||
              widget.type === "kpi" ||
              widget.type === "funnel" ||
              widget.type === "decomposition" ||
              (widget.type === "treemap" && !widget.encoding.series)
            }
          />
        </FormatGroup>
      ) : null}
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
      {widget.type === "treemap" ? (
        <TreemapFormat widget={widget} onChange={onChange} />
      ) : null}
      {widget.type === "decomposition" ? (
        <DecompositionFormat widget={widget} onChange={onChange} />
      ) : null}
    </div>
  );
}

/** 树状图格式分区（对齐 Power BI「设置视觉对象格式 → 树状图」） */
function TreemapFormat({
  widget,
  onChange,
}: {
  widget: ChartWidget;
  onChange: (patch: Partial<ChartWidget>) => void;
}) {
  const cfg = treemapOf(widget);
  const update = (patch: Partial<TreemapConfig>) =>
    onChange({ treemap: { ...cfg, ...patch } });

  return (
    <div className="space-y-1.5">
      <FormatGroup title="树状图" defaultOpen>
        <div className="space-y-1 pb-1">
          <Label htmlFor="fmt-treemap-color" className="text-xs text-muted-foreground">
            配色方式
          </Label>
          <Select
            value={cfg.colorMode}
            onValueChange={(v) => update({ colorMode: v as TreemapColorMode })}
          >
            <SelectTrigger id="fmt-treemap-color" className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="category" className="text-xs">
                按类别（详细信息）
              </SelectItem>
              <SelectItem value="value" className="text-xs">
                按值渐变
              </SelectItem>
              <SelectItem value="single" className="text-xs">
                单色
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {cfg.colorMode !== "category" ? (
          <ColorRow
            id="fmt-treemap-base"
            label="基础颜色"
            value={cfg.baseColor}
            onChange={(v) => update({ baseColor: v })}
          />
        ) : null}
        <div className="flex items-center justify-between py-1">
          <Label htmlFor="fmt-treemap-gap" className="text-xs font-normal">
            分组间距
          </Label>
          <Input
            id="fmt-treemap-gap"
            type="number"
            min={0}
            max={8}
            value={cfg.groupPadding}
            onChange={(e) =>
              update({
                groupPadding: Math.min(8, Math.max(0, Number(e.target.value) || 0)),
              })
            }
            className="h-6 w-16 text-xs"
          />
        </div>
        <ToggleRow
          id="fmt-treemap-border"
          label="显示边框"
          checked={cfg.showBorder}
          onChange={(v) => update({ showBorder: v })}
        />
      </FormatGroup>

      <FormatGroup title="数据标签" defaultOpen>
        <ToggleRow
          id="fmt-treemap-category-label"
          label="显示类别标签"
          checked={cfg.showCategoryLabels}
          onChange={(v) => update({ showCategoryLabels: v })}
        />
        <ToggleRow
          id="fmt-treemap-value-label"
          label="显示值"
          checked={cfg.showValueLabels}
          onChange={(v) => update({ showValueLabels: v })}
        />
        <div className="flex items-center justify-between py-1">
          <Label htmlFor="fmt-treemap-font" className="text-xs font-normal">
            最大字号
          </Label>
          <Input
            id="fmt-treemap-font"
            type="number"
            min={8}
            max={24}
            value={cfg.labelFontSize}
            onChange={(e) =>
              update({
                labelFontSize: Math.min(24, Math.max(8, Number(e.target.value) || 12)),
              })
            }
            className="h-6 w-16 text-xs"
          />
        </div>
        <ColorRow
          id="fmt-treemap-label-color"
          label="标签颜色"
          value={cfg.labelColor}
          onChange={(v) => update({ labelColor: v })}
        />
      </FormatGroup>
    </div>
  );
}

/** 分解树格式分区（对齐 Power BI「设置视觉对象格式 → 分解树」） */
function DecompositionFormat({
  widget,
  onChange,
}: {
  widget: ChartWidget;
  onChange: (patch: Partial<ChartWidget>) => void;
}) {
  const cfg = decompositionOf(widget);
  const update = (patch: Partial<DecompositionConfig>) =>
    onChange({ decomposition: { ...cfg, ...patch } });

  return (
    <div className="space-y-1.5">
      <FormatGroup title="分解树" defaultOpen>
        <ToggleRow
          id="fmt-decomp-bars"
          label="显示数据条"
          checked={cfg.showBars}
          onChange={(v) => update({ showBars: v })}
        />
        {cfg.showBars ? (
          <ColorRow
            id="fmt-decomp-color"
            label="数据条颜色"
            value={cfg.baseColor}
            onChange={(v) => update({ baseColor: v })}
          />
        ) : null}
        <div className="flex items-center justify-between py-1">
          <Label htmlFor="fmt-decomp-max" className="text-xs font-normal">
            每级最大节点数
          </Label>
          <Input
            id="fmt-decomp-max"
            type="number"
            min={2}
            max={20}
            value={cfg.maxBars}
            onChange={(e) =>
              update({
                maxBars: Math.min(20, Math.max(2, Number(e.target.value) || 6)),
              })
            }
            className="h-6 w-16 text-xs"
          />
        </div>
        <ToggleRow
          id="fmt-decomp-headers"
          label="显示级别标题"
          checked={cfg.showLevelHeaders}
          onChange={(v) => update({ showLevelHeaders: v })}
        />
        <ToggleRow
          id="fmt-decomp-connectors"
          label="显示连接线"
          checked={cfg.showConnectors}
          onChange={(v) => update({ showConnectors: v })}
        />
        <ToggleRow
          id="fmt-decomp-ai"
          label="启用 AI 拆分（高值 / 低值）"
          checked={cfg.aiSplits}
          onChange={(v) => update({ aiSplits: v })}
        />
      </FormatGroup>

      <FormatGroup title="数据标签" defaultOpen>
        <ToggleRow
          id="fmt-decomp-values"
          label="显示值"
          checked={cfg.showValues}
          onChange={(v) => update({ showValues: v })}
        />
        <ColorRow
          id="fmt-decomp-label-color"
          label="标签颜色"
          value={cfg.labelColor}
          onChange={(v) => update({ labelColor: v })}
        />
        <div className="flex items-center justify-between py-1">
          <Label htmlFor="fmt-decomp-font" className="text-xs font-normal">
            字号
          </Label>
          <Input
            id="fmt-decomp-font"
            type="number"
            min={8}
            max={20}
            value={cfg.fontSize}
            onChange={(e) =>
              update({
                fontSize: Math.min(20, Math.max(8, Number(e.target.value) || 11)),
              })
            }
            className="h-6 w-16 text-xs"
          />
        </div>
      </FormatGroup>
    </div>
  );
}

/** 切片器格式分区（对齐 Power BI「设置视觉对象格式 → 切片器」） */
function SlicerFormat({
  widget,
  onChange,
}: {
  widget: ChartWidget;
  onChange: (patch: Partial<ChartWidget>) => void;
}) {
  const cfg = slicerOf(widget);
  const fields = widget.filterFields ?? [];
  const update = (patch: Partial<SlicerConfig>) =>
    onChange({ slicer: { ...cfg, ...patch } });

  const listLike = cfg.type === "list" || cfg.type === "dropdown";
  const rangeLike =
    cfg.type === "between" || cfg.type === "before" || cfg.type === "after";

  return (
    <div className="space-y-1.5">
      <FormatGroup title="切片器" defaultOpen>
        <div className="space-y-1 pb-1">
          <Label htmlFor="slicer-type" className="text-xs text-muted-foreground">
            切片器类型
          </Label>
          <Select
            value={cfg.type}
            onValueChange={(v) => update({ type: v as SlicerType })}
          >
            <SelectTrigger id="slicer-type" className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SLICER_TYPE_LABELS) as SlicerType[]).map((t) => (
                <SelectItem key={t} value={t} className="text-xs">
                  {SLICER_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 pb-1">
          <Label
            htmlFor="slicer-mode"
            className="text-xs text-muted-foreground"
          >
            选择模式
          </Label>
          <Select
            value={cfg.selectionMode}
            onValueChange={(v) =>
              update({ selectionMode: v as SlicerSelectionMode })
            }
          >
            <SelectTrigger id="slicer-mode" className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single" className="text-xs">
                单选
              </SelectItem>
              <SelectItem value="multi" className="text-xs">
                多选（⌘/Ctrl 追加）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {cfg.type === "hierarchy" && fields.length < 2 ? (
          <p className="pb-1 text-[11px] leading-relaxed text-muted-foreground">
            层次结构需要两个及以上字段，请继续往「筛选字段」中拖入。
          </p>
        ) : null}
        {rangeLike && fields.length !== 1 ? (
          <p className="pb-1 text-[11px] leading-relaxed text-muted-foreground">
            每个字段各生成一个独立的区间筛选条件。
          </p>
        ) : null}

        {listLike ? (
          <>
            <ToggleRow
              id="slicer-select-all"
              label="显示「全选」"
              checked={cfg.showSelectAll}
              onChange={(v) => update({ showSelectAll: v })}
            />
            <ToggleRow
              id="slicer-search"
              label="显示搜索框"
              checked={cfg.searchable}
              onChange={(v) => update({ searchable: v })}
            />
            {cfg.type === "list" ? (
              <ToggleRow
                id="slicer-horizontal"
                label="水平排列"
                checked={cfg.horizontal}
                onChange={(v) => update({ horizontal: v })}
              />
            ) : null}
          </>
        ) : null}
      </FormatGroup>

      <FormatGroup title="标题" defaultOpen>
        <ToggleRow
          id="slicer-header"
          label="显示标题"
          checked={cfg.showHeader}
          onChange={(v) => update({ showHeader: v })}
        />
        <div className="space-y-1 pt-1">
          <Label
            htmlFor="slicer-header-text"
            className="text-xs text-muted-foreground"
          >
            标题文本
          </Label>
          <Input
            id="slicer-header-text"
            value={cfg.headerText ?? ""}
            onChange={(e) => update({ headerText: e.target.value })}
            placeholder={fields.join(" / ") || "留空则显示字段名"}
            className="h-7 text-xs"
          />
        </div>
      </FormatGroup>

      <FormatGroup title="值" defaultOpen>
        <div className="flex items-center justify-between py-1">
          <Label htmlFor="slicer-font" className="text-xs font-normal">
            字号
          </Label>
          <Input
            id="slicer-font"
            type="number"
            min={8}
            max={30}
            value={cfg.fontSize}
            onChange={(e) =>
              update({
                fontSize: Math.min(30, Math.max(8, Number(e.target.value) || 12)),
              })
            }
            className="h-6 w-16 text-xs"
          />
        </div>
        <ColorRow
          id="slicer-accent"
          label="选中颜色"
          value={cfg.accentColor}
          onChange={(v) => update({ accentColor: v })}
        />
        <ColorRow
          id="slicer-font-color"
          label="字体颜色"
          value={cfg.fontColor}
          onChange={(v) => update({ fontColor: v })}
        />
      </FormatGroup>

      <FormatGroup title="背景与边框" defaultOpen>
        <ColorRow
          id="slicer-bg"
          label="背景色"
          value={cfg.backgroundColor}
          onChange={(v) => update({ backgroundColor: v })}
        />
        <ToggleRow
          id="slicer-border"
          label="显示边框"
          checked={cfg.showBorder}
          onChange={(v) => update({ showBorder: v })}
        />
      </FormatGroup>
    </div>
  );
}

function ColorRow({
  id,
  label,
  value,
  onChange,
  clearable,
  fallback = "#ffffff",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 允许清空（清空后由渲染层回退到默认值） */
  clearable?: boolean;
  /** 空值时的取色器展示色 */
  fallback?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-1">
        {clearable && value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title="清除"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
        <input
          id={id}
          type="color"
          value={value || fallback}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-9 cursor-pointer rounded border border-border bg-transparent p-0"
        />
      </div>
    </div>
  );
}

function NumberRow({
  id,
  label,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))
        }
        className="h-6 w-16 text-xs"
      />
    </div>
  );
}

function SelectRow({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-6 w-20 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
