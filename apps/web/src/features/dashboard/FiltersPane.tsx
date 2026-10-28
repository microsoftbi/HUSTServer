import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import { ChevronDown, Eraser, Eye, EyeOff, Filter, Lock, LockOpen, Search, X } from "lucide-react";
import { Input } from "@bi/components/ui/input";
import { isDecoration } from "@bi/lib/decoration";
import { distinctValues } from "@bi/lib/slicer";
import { filterIsActive } from "@bi/lib/filter";
import { usePushedDistinct } from "./services/pushdown";
import { cn, uid } from "@bi/lib/utils";
import type { ChartWidget, Dataset, FilterCondition, FilterMode } from "@bi/types";

interface FiltersPaneProps {
  /** 所有页面上的筛选器（报表级） */
  reportFilters: FilterCondition[];
  /** 此页上的筛选器 */
  pageFilters: FilterCondition[];
  /** 此视觉对象上的筛选器（当前选中视觉对象） */
  visualFilters: FilterCondition[];
  selectedWidget: ChartWidget | null;
  /** 「数据」窗格当前数据集：新增筛选器时的字段来源 */
  browseDatasetId: string | null;
  datasets: Dataset[];
  onReportFiltersChange: (filters: FilterCondition[]) => void;
  onPageFiltersChange: (filters: FilterCondition[]) => void;
  onVisualFiltersChange: (filters: FilterCondition[]) => void;
  onClose: () => void;
  className?: string;
}

const MODE_LABELS: Record<FilterMode, string> = {
  basic: "基本筛选",
  range: "区间筛选",
  topN: "前 N 项",
};

/** 字段名下的筛选器卡片：基本（值列表）/ 区间 / 前 N 项，支持锁定与隐藏 */
function FilterCard({
  condition,
  dataset,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  dataset: Dataset | undefined;
  onChange: (patch: Partial<FilterCondition>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");

  const mode = condition.mode ?? "basic";
  const locked = !!condition.locked;
  const hidden = !!condition.hidden;

  // 截断数据集的候选值走服务端去重，其余保持本地枚举
  const pushedValues = usePushedDistinct(dataset, condition.field, 1000);
  const values = useMemo(
    () => pushedValues ?? distinctValues(dataset, condition.field, 1000),
    [pushedValues, dataset, condition.field],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  }, [values, query]);

  /** 空数组代表「全部」，即未筛选 */
  const all = condition.values.length === 0;

  /** 勾选/取消某个值；选满全部时归零为「全部」 */
  function toggle(value: string) {
    const current = all ? values : condition.values;
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ values: next.length === values.length ? [] : next });
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded border bg-background",
        hidden && "border-dashed opacity-70",
      )}
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          aria-label={open ? "折叠筛选器" : "展开筛选器"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")}
          />
        </button>
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
          title={condition.field}
        >
          {condition.field}
        </span>
        {filterIsActive(condition) ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="正在筛选" />
        ) : null}
        <button
          type="button"
          title={locked ? "解锁筛选器" : "锁定筛选器"}
          aria-label={locked ? "解锁筛选器" : "锁定筛选器"}
          aria-pressed={locked}
          onClick={() => onChange({ locked: !locked })}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground",
            locked ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
        </button>
        <button
          type="button"
          title={hidden ? "取消隐藏筛选器" : "隐藏筛选器"}
          aria-label={hidden ? "取消隐藏筛选器" : "隐藏筛选器"}
          aria-pressed={hidden}
          onClick={() => onChange({ hidden: !hidden })}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
        {filterIsActive(condition) && !locked ? (
          <button
            type="button"
            title="清除筛选"
            aria-label={`清除${condition.field}的筛选`}
            onClick={() => onChange({ values: [], min: "", max: "", n: 5 })}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Eraser className="h-3 w-3" />
          </button>
        ) : null}
        <button
          type="button"
          title="移除筛选器"
          aria-label={`移除${condition.field}筛选器`}
          onClick={onRemove}
          disabled={locked}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
            locked
              ? "cursor-not-allowed text-muted-foreground/40"
              : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {open ? (
        <div className="border-t px-1.5 pb-1.5 pt-1">
          <div className="mb-1 flex items-center gap-1">
            <select
              aria-label="筛选方式"
              value={mode}
              disabled={locked}
              onChange={(e) => {
                const next = e.target.value as FilterMode;
                onChange({
                  mode: next,
                  ...(next === "topN" ? { n: condition.n ?? 5 } : {}),
                });
              }}
              className="h-6 flex-1 cursor-pointer rounded border border-input bg-transparent px-1 text-[11px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(Object.keys(MODE_LABELS) as FilterMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
            <span className="shrink-0 truncate text-[10px] text-muted-foreground">
              {dataset?.name ?? "数据集缺失"}
            </span>
          </div>

          {mode === "range" ? (
            <div className="flex items-center gap-1">
              <Input
                value={condition.min ?? ""}
                disabled={locked}
                onChange={(e) => onChange({ min: e.target.value })}
                placeholder="最小值"
                className="h-6 text-[11px]"
              />
              <span className="shrink-0 text-[10px] text-muted-foreground">~</span>
              <Input
                value={condition.max ?? ""}
                disabled={locked}
                onChange={(e) => onChange({ max: e.target.value })}
                placeholder="最大值"
                className="h-6 text-[11px]"
              />
            </div>
          ) : mode === "topN" ? (
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-[11px] text-muted-foreground">显示前</span>
              <Input
                type="number"
                min={1}
                value={condition.n ?? 5}
                disabled={locked}
                onChange={(e) =>
                  onChange({ n: Math.max(1, Number(e.target.value) || 1) })
                }
                className="h-6 w-16 text-[11px]"
              />
              <span className="shrink-0 text-[11px] text-muted-foreground">项（按行数）</span>
            </div>
          ) : (
            <>
              {values.length > 8 ? (
                <div className="relative mb-1">
                  <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索…"
                    className="h-6 pl-6 text-[11px]"
                  />
                </div>
              ) : null}

              {values.length === 0 ? (
                <p className="py-1 text-[11px] text-muted-foreground">该字段暂无可选值</p>
              ) : (
                <>
                  <label
                    className={cn(
                      "flex items-center gap-1.5 rounded px-0.5 py-0.5 text-xs",
                      locked ? "opacity-60" : "cursor-pointer hover:bg-accent/60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={all}
                      disabled={locked}
                      onChange={(e) => onChange({ values: e.target.checked ? [] : values })}
                      className="h-3.5 w-3.5 shrink-0 accent-[#2563eb]"
                    />
                    <span className="flex-1 truncate">全选</span>
                  </label>
                  <div className="max-h-44 overflow-auto">
                    {shown.map((v) => (
                      <label
                        key={v}
                        className={cn(
                          "flex items-center gap-1.5 rounded px-0.5 py-0.5 text-xs",
                          locked ? "opacity-60" : "cursor-pointer hover:bg-accent/60",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={all || condition.values.includes(v)}
                          disabled={locked}
                          onChange={() => toggle(v)}
                          className="h-3.5 w-3.5 shrink-0 accent-[#2563eb]"
                        />
                        <span className="min-w-0 flex-1 truncate" title={v}>
                          {v}
                        </span>
                      </label>
                    ))}
                    {shown.length === 0 ? (
                      <p className="px-0.5 py-1 text-[11px] text-muted-foreground">
                        无匹配值
                      </p>
                    ) : null}
                  </div>
                  {!all ? (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      已筛选 {condition.values.length} / {values.length} 项
                    </p>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 章节标题：标题 + 卡片数量（对齐 Power BI 的筛选器分组标题） */
function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-2">
      <span className="text-xs font-semibold text-foreground">{title}</span>
      <span className="text-[10px] text-muted-foreground">{count}</span>
    </div>
  );
}

/** 添加字段下拉：字段来自对应数据集，选中后新增一张筛选器卡片 */
function AddFieldSelect({
  dataset,
  onAdd,
}: {
  dataset: Dataset | undefined;
  onAdd: (field: string) => void;
}) {
  if (!dataset) {
    return <p className="px-0.5 py-1 text-[11px] text-muted-foreground">暂无可用字段</p>;
  }
  return (
    <select
      aria-label="添加筛选字段"
      value=""
      onChange={(e) => {
        const field = e.target.value;
        if (field) onAdd(field);
      }}
      className="h-7 w-full cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <option value="">＋ 添加字段</option>
      {dataset.columns.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** 一组筛选器卡片 + 拖放区 + 添加字段 */
function FilterList({
  filters,
  dataset,
  datasets,
  showHidden,
  onAdd,
  onChange,
  onRemove,
  extra,
}: {
  filters: FilterCondition[];
  dataset: Dataset | undefined;
  datasets: Dataset[];
  showHidden: boolean;
  onAdd: (field: string) => void;
  onChange: (id: string, patch: Partial<FilterCondition>) => void;
  onRemove: (id: string) => void;
  extra?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const visible = filters.filter((f) => showHidden || !f.hidden);

  function dropProps() {
    return {
      onDragOver: (e: DragEvent) => {
        if (!dataset) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!dataset) return;
        e.preventDefault();
        const field =
          e.dataTransfer.getData("application/x-bi-field") ||
          e.dataTransfer.getData("text/plain") ||
          e.dataTransfer.getData("text");
        if (field) onAdd(field);
      },
    };
  }

  return (
    <div
      {...dropProps()}
      className={cn("space-y-1 px-2 pb-2", over && "rounded bg-primary/5 ring-1 ring-primary")}
    >
      {extra}
      {visible.map((f) => (
        <FilterCard
          key={f.id}
          condition={f}
          dataset={datasets.find((d) => d.id === f.datasetId)}
          onChange={(patch) => onChange(f.id, patch)}
          onRemove={() => onRemove(f.id)}
        />
      ))}
      <AddFieldSelect dataset={dataset} onAdd={onAdd} />
    </div>
  );
}

/** 清除筛选器的取值（保留锁定项） */
function cleared(filters: FilterCondition[]): FilterCondition[] {
  return filters.map((f) =>
    f.locked ? f : { ...f, values: [], min: "", max: "", n: 5 },
  );
}

/**
 * Power BI 风格的「筛选器」窗格：
 * 「所有页面上的筛选器」作用于整份报表，「此页上的筛选器」作用于本页所有视觉对象，
 * 「此视觉对象上的筛选器」只作用于当前选中对象。
 * 支持值列表 / 区间 / 前 N 项三种筛选方式，以及锁定与隐藏。
 */
export function FiltersPane({
  reportFilters,
  pageFilters,
  visualFilters,
  selectedWidget,
  browseDatasetId,
  datasets,
  onReportFiltersChange,
  onPageFiltersChange,
  onVisualFiltersChange,
  onClose,
  className,
}: FiltersPaneProps) {
  const [showHidden, setShowHidden] = useState(false);

  const browseDataset = datasets.find((d) => d.id === browseDatasetId) ?? datasets[0];
  // 切片器与装饰元素不承载视觉对象级筛选
  const visualTarget =
    selectedWidget &&
    selectedWidget.type !== "filter" &&
    !isDecoration(selectedWidget.type)
      ? selectedWidget
      : null;
  const visualDataset = datasets.find((d) => d.id === visualTarget?.datasetId);

  /** 通用新增：按归属集合去重后追加一张基本筛选卡片 */
  function addTo(
    filters: FilterCondition[],
    dataset: Dataset | undefined,
    idPrefix: string,
    commit: (next: FilterCondition[]) => void,
    field: string,
  ) {
    const datasetId = dataset?.id;
    if (!datasetId) return;
    if (filters.some((f) => f.datasetId === datasetId && f.field === field)) return;
    commit([...filters, { id: uid(idPrefix), datasetId, field, values: [] }]);
  }

  function patch(
    filters: FilterCondition[],
    commit: (next: FilterCondition[]) => void,
    id: string,
    p: Partial<FilterCondition>,
  ) {
    commit(filters.map((f) => (f.id === id ? { ...f, ...p } : f)));
  }

  const all = [...reportFilters, ...pageFilters, ...visualFilters];
  const hiddenCount = all.filter((f) => f.hidden).length;
  const anyActive = all.some((f) => filterIsActive(f) && !f.locked);

  return (
    <aside
      className={cn("flex min-h-0 w-[220px] shrink-0 flex-col bg-background", className)}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold">筛选器</span>
        {hiddenCount > 0 || showHidden ? (
          <button
            type="button"
            aria-label={showHidden ? "隐藏已隐藏的筛选器" : "显示已隐藏的筛选器"}
            aria-pressed={showHidden}
            title={showHidden ? "隐藏已隐藏的筛选器" : "显示已隐藏的筛选器"}
            onClick={() => setShowHidden((v) => !v)}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground",
              showHidden ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="关闭筛选器窗格"
          title="关闭"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <SectionHeader title="所有页面上的筛选器" count={reportFilters.length} />
        <FilterList
          filters={reportFilters}
          dataset={browseDataset}
          datasets={datasets}
          showHidden={showHidden}
          onAdd={(field) =>
            addTo(reportFilters, browseDataset, "rf", onReportFiltersChange, field)
          }
          onChange={(id, p) => patch(reportFilters, onReportFiltersChange, id, p)}
          onRemove={(id) => onReportFiltersChange(reportFilters.filter((f) => f.id !== id))}
        />

        <div className="border-t" />
        <SectionHeader title="此页上的筛选器" count={pageFilters.length} />
        <FilterList
          filters={pageFilters}
          dataset={browseDataset}
          datasets={datasets}
          showHidden={showHidden}
          onAdd={(field) => addTo(pageFilters, browseDataset, "pf", onPageFiltersChange, field)}
          onChange={(id, p) => patch(pageFilters, onPageFiltersChange, id, p)}
          onRemove={(id) => onPageFiltersChange(pageFilters.filter((f) => f.id !== id))}
        />

        <div className="border-t" />
        <SectionHeader title="此视觉对象上的筛选器" count={visualFilters.length} />
        <FilterList
          filters={visualFilters}
          dataset={visualDataset}
          datasets={datasets}
          showHidden={showHidden}
          onAdd={(field) => addTo(visualFilters, visualDataset, "vf", onVisualFiltersChange, field)}
          onChange={(id, p) => patch(visualFilters, onVisualFiltersChange, id, p)}
          onRemove={(id) => onVisualFiltersChange(visualFilters.filter((f) => f.id !== id))}
          extra={
            visualTarget && visualDataset ? (
              <p className="truncate px-0.5 text-[10px] text-muted-foreground">
                当前视觉对象：
                {visualTarget.title.trim() || visualTarget.type}
              </p>
            ) : (
              <p className="px-0.5 py-1 text-[11px] leading-4 text-muted-foreground">
                在画布上选择一个图表，即可为它单独添加筛选条件。
              </p>
            )
          }
        />
      </div>

      {anyActive ? (
        <div className="shrink-0 border-t px-2 py-1">
          <button
            type="button"
            onClick={() => {
              onReportFiltersChange(cleared(reportFilters));
              onPageFiltersChange(cleared(pageFilters));
              onVisualFiltersChange(cleared(visualFilters));
            }}
            className="flex h-7 w-full items-center justify-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Eraser className="h-3.5 w-3.5" />
            清除所有筛选器
          </button>
        </div>
      ) : null}
    </aside>
  );
}
