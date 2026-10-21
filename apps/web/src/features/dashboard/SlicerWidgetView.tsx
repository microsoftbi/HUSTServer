import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Filter,
  Search,
  X,
} from "lucide-react";
import { Input } from "@bi/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bi/components/ui/select";
import { cn } from "@bi/lib/utils";
import { normalizeLabel } from "@bi/lib/aggregate";
import type {
  CellValue,
  ChartWidget,
  Dataset,
  SlicerConfig,
  SlicerRange,
  SlicerRelativeDirection,
  SlicerRelativeUnit,
  SlicerState,
} from "@bi/types";
import {
  SLICER_UNIT_LABELS,
  clearSlicerState,
  columnTypeOf,
  distinctValues,
  numericBounds,
  relativeRange,
  selectAllValues,
  setSlicerRange,
  setSlicerRelative,
  slicerActive,
  slicerOf,
  toggleSlicerValue,
} from "@bi/lib/slicer";

interface SlicerWidgetViewProps {
  widget: ChartWidget;
  dataset: Dataset | undefined;
  /** 尺寸过小时仅保留图标，避免内容溢出 */
  compact: boolean;
  onChange: (slicer: SlicerConfig) => void;
}

/**
 * Power BI 风格切片器：直接渲染在画布上，选择值后立即过滤所有视觉对象。
 * 支持列表 / 下拉 / 介于 / 之前 / 之后 / 相对日期 / 层次结构，
 * 以及单选、多选、全选、搜索、清除与外观配置。
 */
export function SlicerWidgetView({
  widget,
  dataset,
  compact,
  onChange,
}: SlicerWidgetViewProps) {
  const cfg = slicerOf(widget);
  const fields = widget.filterFields ?? [];
  const active = slicerActive(cfg, fields);

  const patch = (p: Partial<SlicerConfig>) => onChange({ ...cfg, ...p });
  const setState = (state: SlicerState) => patch({ state });

  const header =
    cfg.headerText?.trim() || (fields.length > 0 ? fields.join(" / ") : "切片器");

  const border = cfg.showBorder ? "1px solid #d1d1d1" : "1px solid transparent";

  if (compact) {
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-sm"
        style={{ backgroundColor: cfg.backgroundColor, border }}
        title={fields.join(" / ") || "切片器"}
      >
        <Filter className="h-3 w-3" style={{ color: cfg.accentColor }} />
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-md px-2 text-center"
        style={{ backgroundColor: cfg.backgroundColor, border }}
      >
        <Filter className="h-4 w-4" style={{ color: cfg.accentColor }} />
        <p className="text-[11px] leading-tight text-muted-foreground">
          把数据列拖入右侧「字段」区
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-md"
      style={{ backgroundColor: cfg.backgroundColor, border, color: cfg.fontColor }}
    >
      {cfg.showHeader ? (
        <div className="flex shrink-0 items-center gap-1 px-2 pb-0.5 pt-1.5">
          <span
            className="min-w-0 flex-1 truncate text-left font-semibold"
            style={{ fontSize: cfg.fontSize }}
            title={header}
          >
            {header}
          </span>
          {active ? (
            <button
              type="button"
              data-no-drag
              title="清除筛选"
              aria-label="清除筛选"
              onClick={() => setState(clearSlicerState(cfg.state))}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-black/10 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-1.5 pb-1.5 pt-0.5">
        <SlicerBody
          cfg={cfg}
          dataset={dataset}
          fields={fields}
          onChange={patch}
        />
      </div>
    </div>
  );
}

function SlicerBody({
  cfg,
  dataset,
  fields,
  onChange,
}: {
  cfg: SlicerConfig;
  dataset: Dataset | undefined;
  fields: string[];
  onChange: (patch: Partial<SlicerConfig>) => void;
}) {
  const state = cfg.state;

  if (cfg.type === "relativeDate") {
    return (
      <RelativeDateBody cfg={cfg} onChange={onChange} />
    );
  }

  if (cfg.type === "between" || cfg.type === "before" || cfg.type === "after") {
    return (
      <div className="min-h-0 flex-1 space-y-1 overflow-auto">
        {fields.map((field) => (
          <RangeBody
            key={field}
            cfg={cfg}
            dataset={dataset}
            field={field}
            showFieldLabel={fields.length > 1}
            onChange={onChange}
          />
        ))}
      </div>
    );
  }

  if (cfg.type === "hierarchy") {
    return (
      <HierarchyBody
        cfg={cfg}
        dataset={dataset}
        fields={fields}
        onChange={onChange}
      />
    );
  }

  const field = fields[0];
  const values = distinctValues(dataset, field);
  const selected = state.selections[field] ?? [];
  const toggle = (value: string, additive: boolean) =>
    onChange({
      state: toggleSlicerValue(
        state,
        field,
        value,
        cfg.selectionMode,
        additive,
      ),
    });
  const selectAll = () => onChange({ state: selectAllValues(state, field) });

  if (cfg.type === "dropdown") {
    return (
      <DropdownBody
        cfg={cfg}
        values={values}
        selected={selected}
        onToggle={toggle}
        onSelectAll={selectAll}
      />
    );
  }

  return (
    <ValueList
      values={values}
      selected={selected}
      multi={cfg.selectionMode === "multi"}
      showSelectAll={cfg.showSelectAll}
      searchable={cfg.searchable}
      horizontal={cfg.horizontal}
      accentColor={cfg.accentColor}
      fontSize={cfg.fontSize}
      onToggle={toggle}
      onSelectAll={selectAll}
    />
  );
}

/* ------------------------------ 列表 / 下拉 ------------------------------ */

function ValueList({
  values,
  selected,
  multi,
  showSelectAll,
  searchable,
  horizontal,
  accentColor,
  fontSize,
  onToggle,
  onSelectAll,
}: {
  values: string[];
  selected: string[];
  multi: boolean;
  showSelectAll: boolean;
  searchable: boolean;
  horizontal: boolean;
  accentColor: string;
  fontSize: number;
  onToggle: (value: string, additive: boolean) => void;
  onSelectAll: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = q
    ? values.filter((v) => v.toLowerCase().includes(q))
    : values;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchable ? (
        <div className="relative mb-1 shrink-0">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            aria-label="搜索切片器值"
            className="h-6 w-full rounded border border-border bg-background pl-6 pr-1.5 outline-none focus:border-[#2563eb]"
            style={{ fontSize }}
          />
        </div>
      ) : null}

      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          horizontal ? "flex flex-wrap content-start gap-x-3" : "space-y-px",
        )}
      >
        {showSelectAll && multi ? (
          <SlicerItem
            label="全选"
            checked={selected.length === 0}
            accentColor={accentColor}
            fontSize={fontSize}
            inline={horizontal}
            onClick={onSelectAll}
          />
        ) : null}
        {visible.map((value) => (
          <SlicerItem
            key={value}
            label={value}
            checked={selected.includes(value)}
            accentColor={accentColor}
            fontSize={fontSize}
            inline={horizontal}
            onClick={(e) => onToggle(value, e.metaKey || e.ctrlKey)}
          />
        ))}
        {visible.length === 0 ? (
          <p
            className="px-1 py-1 text-muted-foreground"
            style={{ fontSize }}
          >
            无匹配项
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SlicerItem({
  label,
  checked,
  accentColor,
  fontSize,
  inline,
  onClick,
}: {
  label: string;
  checked: boolean;
  accentColor: string;
  fontSize: number;
  inline?: boolean;
  onClick: (e: ReactMouseEvent) => void;
}) {
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      title={label}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-black/5",
        inline ? "max-w-full shrink-0" : "w-full",
      )}
      style={{ fontSize }}
    >
      <span
        className="flex h-3 w-3 shrink-0 items-center justify-center rounded-[2px] border"
        style={{
          borderColor: checked ? accentColor : "#a19f9d",
          backgroundColor: checked ? accentColor : "transparent",
        }}
      >
        {checked ? <Check className="h-2 w-2" strokeWidth={4} color="#ffffff" /> : null}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function DropdownBody({
  cfg,
  values,
  selected,
  onToggle,
  onSelectAll,
}: {
  cfg: SlicerConfig;
  values: string[];
  selected: string[];
  onToggle: (value: string, additive: boolean) => void;
  onSelectAll: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 240 });

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (btnRef.current?.contains(target as Node)) return;
      if (target?.closest?.("[data-slicer-popover]")) return;
      setOpen(false);
    }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = 280;
    const top =
      rect.bottom + height > window.innerHeight
        ? Math.max(8, rect.top - height - 4)
        : rect.bottom + 4;
    setPos({ left: rect.left, top, width: Math.max(rect.width, 220) });
    setOpen(true);
  }

  const summary =
    selected.length === 0
      ? "全部"
      : selected.length === 1
        ? selected[0]
        : `已选 ${selected.length} 项`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-no-drag
        onClick={toggleOpen}
        title={summary}
        className="flex h-full max-h-8 min-h-6 w-full items-center gap-1 rounded border border-border bg-background px-1.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate" style={{ fontSize: cfg.fontSize }}>
          {summary}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open
        ? createPortal(
            <div
              data-slicer-popover
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                width: pos.width,
                maxHeight: 280,
                zIndex: 90,
                color: cfg.fontColor,
                backgroundColor: cfg.backgroundColor,
              }}
              className="flex flex-col overflow-hidden rounded-md border p-1.5 shadow-lg"
            >
              <ValueList
                values={values}
                selected={selected}
                multi={cfg.selectionMode === "multi"}
                showSelectAll={cfg.showSelectAll}
                searchable={cfg.searchable}
                horizontal={false}
                accentColor={cfg.accentColor}
                fontSize={cfg.fontSize}
                onToggle={onToggle}
                onSelectAll={onSelectAll}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ------------------------------ 区间类 ------------------------------ */

function formatDate(t: number): string {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function RangeBody({
  cfg,
  dataset,
  field,
  showFieldLabel,
  onChange,
}: {
  cfg: SlicerConfig;
  dataset: Dataset | undefined;
  field: string;
  showFieldLabel: boolean;
  onChange: (patch: Partial<SlicerConfig>) => void;
}) {
  const type = columnTypeOf(dataset, field);
  const range = cfg.state.ranges[field];
  const isDate = type === "date";
  const showMin = cfg.type !== "before";
  const showMax = cfg.type !== "after";

  const setRange = (next: SlicerRange) =>
    onChange({ state: setSlicerRange(cfg.state, field, next) });

  const bounds = useMemo(
    () => (type === "number" ? numericBounds(dataset, field) : null),
    [dataset, field, type],
  );

  const lo = range?.min !== undefined && range.min !== "" && bounds
    ? Math.max(bounds.min, Number(range.min))
    : bounds?.min;
  const hi = range?.max !== undefined && range.max !== "" && bounds
    ? Math.min(bounds.max, Number(range.max))
    : bounds?.max;

  return (
    <div className="space-y-1">
      {showFieldLabel ? (
        <div
          className="truncate font-medium text-muted-foreground"
          style={{ fontSize: Math.max(10, cfg.fontSize - 1) }}
        >
          {field}
        </div>
      ) : null}

      {isDate ? (
        <div className="flex items-center gap-1">
          {showMin ? (
            <input
              type="date"
              aria-label="起始日期"
              value={range?.min ?? ""}
              onChange={(e) => setRange({ ...range, min: e.target.value })}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 outline-none"
              style={{ fontSize: cfg.fontSize }}
            />
          ) : null}
          {showMin && showMax ? (
            <span className="text-muted-foreground">~</span>
          ) : null}
          {showMax ? (
            <input
              type="date"
              aria-label="结束日期"
              value={range?.max ?? ""}
              onChange={(e) => setRange({ ...range, max: e.target.value })}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 outline-none"
              style={{ fontSize: cfg.fontSize }}
            />
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1">
            {showMin ? (
              <input
                type="number"
                aria-label="最小值"
                placeholder={bounds ? String(bounds.min) : "最小"}
                value={range?.min ?? ""}
                onChange={(e) => setRange({ ...range, min: e.target.value })}
                className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 outline-none"
                style={{ fontSize: cfg.fontSize }}
              />
            ) : null}
            {showMin && showMax ? (
              <span className="text-muted-foreground">~</span>
            ) : null}
            {showMax ? (
              <input
                type="number"
                aria-label="最大值"
                placeholder={bounds ? String(bounds.max) : "最大"}
                value={range?.max ?? ""}
                onChange={(e) => setRange({ ...range, max: e.target.value })}
                className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 outline-none"
                style={{ fontSize: cfg.fontSize }}
              />
            ) : null}
          </div>

          {bounds && showMin && lo !== undefined ? (
            <div className="flex items-center gap-1">
              <input
                type="range"
                aria-label="最小值滑块"
                min={bounds.min}
                max={bounds.max}
                value={lo}
                onChange={(e) => setRange({ ...range, min: e.target.value })}
                className="h-3 min-w-0 flex-1 accent-[#2563eb]"
              />
            </div>
          ) : null}
          {bounds && showMax && hi !== undefined ? (
            <div className="flex items-center gap-1">
              <input
                type="range"
                aria-label="最大值滑块"
                min={bounds.min}
                max={bounds.max}
                value={hi}
                onChange={(e) => setRange({ ...range, max: e.target.value })}
                className="h-3 min-w-0 flex-1 accent-[#2563eb]"
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------ 相对日期 ------------------------------ */

function RelativeDateBody({
  cfg,
  onChange,
}: {
  cfg: SlicerConfig;
  onChange: (patch: Partial<SlicerConfig>) => void;
}) {
  const rel = cfg.state.relative;
  const preview = useMemo(() => relativeRange(rel), [rel]);

  const setRel = (patch: Partial<typeof rel>) =>
    onChange({ state: setSlicerRelative(cfg.state, { ...rel, ...patch }) });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <Select
          value={rel.direction}
          onValueChange={(v) =>
            setRel({ direction: v as SlicerRelativeDirection })
          }
        >
          <SelectTrigger
            className="h-6 w-[68px] px-1.5 text-xs"
            aria-label="相对日期方向"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last" className="text-xs">
              过去
            </SelectItem>
            <SelectItem value="next" className="text-xs">
              接下来
            </SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="number"
          min={1}
          aria-label="相对日期数量"
          value={rel.count}
          onChange={(e) =>
            setRel({ count: Math.max(1, Number(e.target.value) || 1) })
          }
          className="h-6 w-12 px-1 text-xs"
        />

        <Select
          value={rel.unit}
          onValueChange={(v) => setRel({ unit: v as SlicerRelativeUnit })}
        >
          <SelectTrigger
            className="h-6 w-[62px] px-1.5 text-xs"
            aria-label="相对日期单位"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["day", "week", "month", "year"] as SlicerRelativeUnit[]).map(
              (u) => (
                <SelectItem key={u} value={u} className="text-xs">
                  {SLICER_UNIT_LABELS[u]}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </div>
      <p
        className="truncate text-muted-foreground"
        style={{ fontSize: Math.max(10, cfg.fontSize - 1) }}
      >
        {formatDate(preview.from)} ~ {formatDate(preview.to)}
      </p>
    </div>
  );
}

/* ------------------------------ 层次结构 ------------------------------ */

interface TreeNode {
  value: string;
  children: TreeNode[];
}

function buildNodes(
  rows: CellValue[][],
  indexes: number[],
  depth: number,
): TreeNode[] {
  if (depth >= indexes.length) return [];
  const idx = indexes[depth];
  if (idx < 0) return [];
  const order: string[] = [];
  const groups = new Map<string, CellValue[][]>();
  for (const row of rows) {
    const key = normalizeLabel(row[idx]);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }
  return order.map((value) => ({
    value,
    children: buildNodes(groups.get(value)!, indexes, depth + 1),
  }));
}

function HierarchyBody({
  cfg,
  dataset,
  fields,
  onChange,
}: {
  cfg: SlicerConfig;
  dataset: Dataset | undefined;
  fields: string[];
  onChange: (patch: Partial<SlicerConfig>) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    if (!dataset) return [];
    const indexes = fields.map(
      (f) => dataset.columns.findIndex((c) => c.name === f),
    );
    return buildNodes(dataset.rows, indexes, 0);
  }, [dataset, fields]);

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderNodes(nodes: TreeNode[], depth: number, parentKey: string) {
    return nodes.map((node) => {
      const key = `${parentKey}/${depth}:${node.value}`;
      const field = fields[depth];
      const checked = (cfg.state.selections[field] ?? []).includes(node.value);
      return (
        <div key={key}>
          <div className="flex min-w-0 items-center gap-0.5">
            {node.children.length > 0 ? (
              <button
                type="button"
                data-no-drag
                aria-label={expanded.has(key) ? "折叠" : "展开"}
                onClick={() => toggleExpand(key)}
                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-black/10"
              >
                {expanded.has(key) ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <SlicerItem
              label={node.value}
              checked={checked}
              accentColor={cfg.accentColor}
              fontSize={cfg.fontSize}
              onClick={(e) =>
                onChange({
                  state: toggleSlicerValue(
                    cfg.state,
                    field,
                    node.value,
                    cfg.selectionMode,
                    e.metaKey || e.ctrlKey,
                  ),
                })
              }
            />
          </div>
          {expanded.has(key) && node.children.length > 0 ? (
            <div className="pl-3">
              {renderNodes(node.children, depth + 1, key)}
            </div>
          ) : null}
        </div>
      );
    });
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto space-y-px">
      {tree.length === 0 ? (
        <p className="px-1 py-1 text-muted-foreground" style={{ fontSize: cfg.fontSize }}>
          无数据
        </p>
      ) : (
        renderNodes(tree, 0, "")
      )}
    </div>
  );
}
