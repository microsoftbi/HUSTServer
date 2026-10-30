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
import { usePushedDistinct } from "./services/pushdown";
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
  dateBounds,
  distinctValues,
  formatDateLabel,
  numericBounds,
  relativeRange,
  selectAllValues,
  setSlicerRange,
  setSlicerRelative,
  slicerActive,
  slicerOf,
  toDateInputValue,
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
          // 高度不足时省略「数据范围」辅助行，避免被卡片裁切
          roomy={widget.layout.h >= 110}
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
  roomy,
  onChange,
}: {
  cfg: SlicerConfig;
  dataset: Dataset | undefined;
  fields: string[];
  /** 视觉对象高度是否允许显示辅助信息行 */
  roomy: boolean;
  onChange: (patch: Partial<SlicerConfig>) => void;
}) {
  const state = cfg.state;
  // 截断数据集的候选值需要覆盖全量行，走服务端去重；hook 须在早返回之前调用
  const listField =
    cfg.type === "list" || cfg.type === "dropdown" ? fields[0] : undefined;
  const pushedValues = usePushedDistinct(dataset, listField);

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
            roomy={roomy}
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
  const values = pushedValues ?? distinctValues(dataset, field);
  const selected = state.selections[field] ?? [];
  // 日期列的值是零时刻 ISO，展示时统一成短日期（与 Power BI 一致）
  const labelOf =
    columnTypeOf(dataset, field) === "date" ? formatDateLabel : undefined;
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
        labelOf={labelOf}
        onToggle={toggle}
        onSelectAll={selectAll}
      />
    );
  }

  return (
    <ValueList
      values={values}
      selected={selected}
      labelOf={labelOf}
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
  labelOf,
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
  /** 值的展示标签（日期列转短日期），不传则直接展示原值 */
  labelOf?: (value: string) => string;
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
  const label = labelOf ?? ((v: string) => v);
  const q = query.trim().toLowerCase();
  const visible = q
    ? values.filter((v) => label(v).toLowerCase().includes(q))
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
            label={label(value)}
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
  labelOf,
  onToggle,
  onSelectAll,
}: {
  cfg: SlicerConfig;
  values: string[];
  selected: string[];
  labelOf?: (value: string) => string;
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

  const label = labelOf ?? ((v: string) => v);
  const summary =
    selected.length === 0
      ? "全部"
      : selected.length === 1
        ? label(selected[0])
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
                labelOf={labelOf}
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
  roomy,
  onChange,
}: {
  cfg: SlicerConfig;
  dataset: Dataset | undefined;
  field: string;
  showFieldLabel: boolean;
  /** 视觉对象高度是否允许显示辅助信息行 */
  roomy: boolean;
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
  // 日期列的取值区间：为输入框提供上下限，并支持按天的区间滑块（对齐 Power BI）
  const dates = useMemo(
    () => (type === "date" ? dateBounds(dataset, field) : null),
    [dataset, field, type],
  );

  const lo = range?.min !== undefined && range.min !== "" && bounds
    ? Math.max(bounds.min, Number(range.min))
    : bounds?.min;
  const hi = range?.max !== undefined && range.max !== "" && bounds
    ? Math.min(bounds.max, Number(range.max))
    : bounds?.max;

  /** 区间滑块使用「天」为步长，值仍以 yyyy-MM-dd 落库 */
  const dayLo = dates
    ? Math.min(
        dates.max,
        Math.max(dates.min, range?.min ? Date.parse(range.min) : dates.min),
      )
    : undefined;
  const dayHi = dates
    ? Math.min(
        dates.max,
        Math.max(dates.min, range?.max ? Date.parse(range.max) : dates.max),
      )
    : undefined;

  /** 输入框显示值收敛到数据范围内，否则原生校验会把日期标成非法 */
  const clampedDate = (
    raw: string | undefined,
    lower: number | undefined,
    upper: number | undefined,
  ) => {
    const t = raw ? Date.parse(raw) : NaN;
    if (Number.isNaN(t) || !dates) return toDateInputValue(raw);
    return toDateInputValue(
      Math.min(upper ?? dates.max, Math.max(lower ?? dates.min, t)),
    );
  };

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
        <>
          <div className="flex items-center gap-1">
            {showMin ? (
              <input
                type="date"
                aria-label="起始日期"
                min={dates?.minLabel}
                max={dates?.maxLabel}
                value={clampedDate(range?.min, dates?.min, dayHi)}
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
                min={dates?.minLabel}
                max={dates?.maxLabel}
                value={clampedDate(range?.max, dayLo, dates?.max)}
                onChange={(e) => setRange({ ...range, max: e.target.value })}
                className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 outline-none"
                style={{ fontSize: cfg.fontSize }}
              />
            ) : null}
          </div>

          {dates && dates.min < dates.max ? (
            <DualDateSlider
              min={dates.min}
              max={dates.max}
              value={[dayLo ?? dates.min, dayHi ?? dates.max]}
              // 单侧模式（之前/之后）只回写可见的一端
              onChange={([nextLo, nextHi]) =>
                setRange({
                  ...range,
                  ...(showMin ? { min: toDateInputValue(nextLo) } : {}),
                  ...(showMax ? { max: toDateInputValue(nextHi) } : {}),
                })
              }
              labels={["起始日期滑块", "结束日期滑块"]}
              active={[showMin, showMax]}
              title={`数据范围 ${dates.minLabel} ~ ${dates.maxLabel}`}
            />
          ) : null}
          {dates && roomy ? (
            <div
              className="flex items-center justify-between gap-1 text-muted-foreground"
              style={{ fontSize: Math.max(10, cfg.fontSize - 2) }}
            >
              <span className="truncate">{dates.minLabel}</span>
              <span className="truncate">{dates.maxLabel}</span>
            </div>
          ) : null}
        </>
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

/**
 * 单轨道双滑块（对齐 Power BI 的区间切片器）：轨道自己画，
 * 两个原生 range 叠在上层只让滑块响应指针；点轨道则由命中层把最近的滑块移过去。
 */
function DualDateSlider({
  min,
  max,
  value,
  onChange,
  labels,
  active = [true, true],
  title,
}: {
  min: number;
  max: number;
  value: [number, number];
  onChange: (next: [number, number]) => void;
  labels: [string, string];
  /** 单侧模式（之前/之后）只有一端可动 */
  active?: [boolean, boolean];
  title?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1, max - min);
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));
  const [lo, hi] = value;
  const loPct = pct(lo);
  const hiPct = pct(hi);
  // 两个滑块重合时，靠前的滑块需在上层才拖得动
  const loOnTop = loPct + hiPct > 100;

  /** 点击轨道：吸附到最近的那一端，避免圆点太小不好抓 */
  const moveNearest = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const raw = min + ratio * span;
    const snapped = min + Math.round((raw - min) / 86_400_000) * 86_400_000;
    const next = Math.min(max, Math.max(min, snapped));
    const [loActive, hiActive] = active;
    const moveLo =
      loActive && (!hiActive || Math.abs(next - lo) <= Math.abs(next - hi));
    if (moveLo) {
      onChange([Math.min(next, hi), hi]);
    } else {
      onChange([lo, Math.max(next, lo)]);
    }
  };

  const thumb = [
    "pointer-events-none absolute inset-x-0 top-0 h-4 w-full appearance-none bg-transparent",
    "[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:box-border",
    "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none",
    "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2",
    "[&::-webkit-slider-thumb]:border-[#2563eb] [&::-webkit-slider-thumb]:bg-white",
    "[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
    "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5",
    "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2",
    "[&::-moz-range-thumb]:border-[#2563eb] [&::-moz-range-thumb]:bg-white",
  ].join(" ");

  return (
    <div ref={boxRef} className="relative h-4 w-full min-w-0" title={title}>
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#dbeafe]" />
      <div
        className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#2563eb]"
        style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
      />
      {/* 轨道命中层：比圆点大得多，点哪就把最近的一端移过去 */}
      <div
        role="presentation"
        className="absolute inset-x-0 bottom-0 top-0 cursor-pointer"
        style={{ zIndex: 1 }}
        onPointerDown={(e) => {
          e.preventDefault();
          moveNearest(e.clientX);
        }}
      />
      <input
        type="range"
        aria-label={labels[0]}
        min={min}
        max={max}
        step={86_400_000}
        value={lo}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange([Math.min(next, hi), hi]);
        }}
        className={thumb}
        style={{ zIndex: loOnTop ? 3 : 2 }}
      />
      <input
        type="range"
        aria-label={labels[1]}
        min={min}
        max={max}
        step={86_400_000}
        value={hi}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange([lo, Math.max(next, lo)]);
        }}
        className={thumb}
        style={{ zIndex: 2 }}
      />
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
  const enabled = rel.enabled !== false;
  const preview = useMemo(() => relativeRange(rel), [rel]);

  const setRel = (patch: Partial<typeof rel>) =>
    onChange({ state: setSlicerRelative(cfg.state, { ...rel, ...patch }) });

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-muted-foreground" style={{ fontSize: cfg.fontSize }}>
        <input
          type="checkbox"
          aria-label="启用相对日期筛选"
          checked={enabled}
          onChange={(e) => setRel({ enabled: e.target.checked })}
          className="h-3 w-3 accent-[#2563eb]"
        />
        启用相对日期
      </label>
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
        {enabled ? `${formatDate(preview.from)} ~ ${formatDate(preview.to)}` : "全部日期（不筛选）"}
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
      const isDate = columnTypeOf(dataset, field) === "date";
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
              label={isDate ? formatDateLabel(node.value) : node.value}
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
