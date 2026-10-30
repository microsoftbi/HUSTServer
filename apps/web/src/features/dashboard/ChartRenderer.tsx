import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PieLabelRenderProps } from "recharts";
import { ChevronDown, ChevronUp } from "lucide-react";
import type {
  ButtonAction,
  CellValue,
  ChartWidget,
  Dataset,
  FieldFormat,
  ReferenceLine as ReferenceLineConfig,
} from "@bi/types";
import {
  aggregate,
  applyViewOptions,
  effectiveDimensions,
  hierarchyFields,
  measureKey,
  OTHERS_LABEL,
  type AggregatedData,
} from "@bi/lib/aggregate";
import { colorAt, normalizeToPercent } from "@bi/lib/chart";
import { DataTable } from "@bi/components/DataTable";
import { DecorationView } from "./DecorationView";
import { isDecoration } from "@bi/lib/decoration";
import { MapChart } from "./MapChart";
import { PivotTable } from "./PivotTable";
import { TreemapChart } from "./TreemapChart";
import { DecompositionTree } from "./DecompositionTree";
import { formatCell, formatNumber } from "@bi/lib/format";
import { formatDateLabel } from "@bi/lib/slicer";
import {
  appliesTo,
  cellDecor,
  chartFill,
  conditionalOf,
  rangeOf,
  type CellDecor,
  type ValueRange,
} from "@bi/lib/conditional";
import {
  applyValueFilters,
  cellOpacity,
  drillValueFilters,
  filterDataset,
  type CrossFilter,
  type HighlightSelection,
  type ValueFilter,
} from "@bi/lib/highlight";
import { usePushedAggregate } from "./services/pushdown";
import { useMemo, type MouseEvent, type ReactNode } from "react";

interface ChartRendererProps {
  widget: ChartWidget;
  dataset: Dataset | undefined;
  /** 当前交叉高亮状态（瞬时态，不参与聚合） */
  highlight?: HighlightSelection | null;
  /** 来自其它视觉对象的交叉筛选条件（源视觉对象自身不传） */
  crossFilter?: CrossFilter | null;
  /** 仪表板级筛选器取值：命中字段的行会被保留 */
  filters?: ValueFilter[] | null;
  /** 点击图元回调：field 为分组字段，value 为标签值，additive 表示 ⌘/Ctrl 多选 */
  onPointClick?: (field: string, value: string, additive: boolean) => void;
  /** 视觉对象自身配置变更（分解树的展开状态需要回写并落库） */
  onWidgetChange?: (patch: Partial<ChartWidget>) => void;
  /** 按钮类装饰元素的点击动作 */
  onButtonAction?: (action: ButtonAction) => void;
}

/**
 * 包装层：截断数据集需要先向服务端要聚合结果，hook 不能放在有早返回的内容层里，
 * 因此这里只负责取数，渲染交给 ChartRendererBody。
 */
export function ChartRenderer(props: ChartRendererProps) {
  // 钻取层级 → 行筛选：本地聚合与下推聚合都必须基于同一份「当前层」数据
  const drillFilters = useMemo(() => drillValueFilters(props.widget), [props.widget]);
  const mergedFilters = useMemo(
    () =>
      drillFilters.length > 0
        ? [...(props.filters ?? []), ...drillFilters]
        : props.filters,
    [props.filters, drillFilters],
  );
  const pushed = usePushedAggregate(
    props.widget,
    props.dataset,
    mergedFilters,
    props.crossFilter,
  );
  return <ChartRendererBody {...props} filters={mergedFilters} pushed={pushed} />;
}

interface ChartRendererBodyProps extends ChartRendererProps {
  /** 服务端聚合结果；null 表示使用本地聚合 */
  pushed: AggregatedData | null;
}

function ChartRendererBody({
  widget,
  dataset,
  highlight = null,
  crossFilter = null,
  filters = null,
  onPointClick,
  onWidgetChange,
  onButtonAction,
  pushed,
}: ChartRendererBodyProps) {
  // 装饰元素不依赖数据集，需在「数据集丢失 / 未配置度量」判断之前分流
  if (isDecoration(widget.type)) {
    return (
      <DecorationView
        widget={widget}
        onChange={onWidgetChange}
        onButtonAction={onButtonAction}
        dataset={dataset}
        filters={filters}
      />
    );
  }

  if (!dataset) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        数据集已丢失，请重新配置
      </div>
    );
  }

  if (widget.encoding.measures.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        请在配置中选择度量字段
      </div>
    );
  }

  // 仪表板筛选器先过滤行，交叉筛选再叠加，最后重新聚合
  const filtered = filterDataset(applyValueFilters(dataset, filters), crossFilter);
  // 当前层级分组字段（与下推规格保持一致：X 轴多字段自动成层 / 钻取 / 展开）
  const dimensions = effectiveDimensions(widget.encoding, widget.drill);
  /**
   * 单字段日期维度：坐标轴与工具提示展示短日期，
   * 避免把 `2010-12-29T00:00:00.000Z` 原样铺到轴上（对齐 Power BI）。
   */
  const categoryLabel =
    dimensions.length === 1 &&
    filtered.columns.find((c) => c.name === dimensions[0])?.type === "date"
      ? formatDateLabel
      : undefined;
  // 截断数据集用服务端聚合结果（本地只有前 N 行）；其余情况保持本地聚合
  const base = pushed ?? aggregate(filtered, widget.encoding, dimensions);
  // 排序 / Top N 属于展示层口径：本地与服务端两种聚合结果共用同一套后处理
  const agg = applyViewOptions(
    base,
    widget.type === "kpi" ? {} : { sort: widget.sort, topN: widget.topN },
  );
  const keys = agg.series.length > 0 ? agg.series : agg.measureKeys;
  const showLegend = widget.showLegend ?? true;

  /** 各数值列的合计，用于工具提示中的占比 */
  const totals = new Map<string, number>();
  for (const key of keys) {
    totals.set(
      key,
      agg.data.reduce(
        (acc, row) => acc + (typeof row[key] === "number" ? (row[key] as number) : 0),
        0,
      ),
    );
  }
  const totalOf = (key: string) => totals.get(key) ?? 0;

  /**
   * 聚合 key → 原始字段名：无系列分组时 key 为 `sum(字段)`，
   * 系列分组时 key 为系列值、度量统一取首个。字段格式以列名为 key 存储。
   */
  const measureFieldOf = (key: string) => {
    const measures = widget.encoding.measures;
    if (agg.series.length > 0) return measures[0]?.field ?? key;
    return measures.find((m) => measureKey(m) === key)?.field ?? key;
  };
  /** 按聚合 key 取字段级数值格式（命名度量优先取度量自身格式） */
  const formatOf = (key: string) => {
    const named = widget.encoding.measures.find(
      (m) => m.measureId && measureKey(m) === key,
    );
    const namedFormat = named?.measureId
      ? dataset.measures?.[named.measureId]?.format
      : undefined;
    return namedFormat ?? dataset.formats?.[measureFieldOf(key)];
  };
  /** 聚合 key → 格式映射（表格 / 透视表的列名即聚合 key） */
  const keyFormats: Record<string, FieldFormat> = {};
  for (const k of Object.keys(agg.data[0] ?? {})) {
    const f = formatOf(k);
    if (f) keyFormats[k] = f;
  }

  // 条件格式：按数值列的取值范围（最小/最大/均值/中位数）计算装饰
  const conditional = conditionalOf(widget);
  const ranges = new Map<string, ValueRange | null>();
  if (conditional) {
    for (const k of keys) {
      ranges.set(k, rangeOf(agg.data.map((row) => row[k])));
    }
  }
  const rangeFor = (key: string) => ranges.get(key) ?? null;
  /** 表格 / 矩阵单元格装饰（条件格式） */
  const decorFor = (column: string, value: CellValue): CellDecor | null => {
    if (!conditional || !appliesTo(conditional, column)) return null;
    return cellDecor(value, rangeFor(column), conditional);
  };

  // 参考线与目标带：统计量按全部数值系列汇总后计算
  const refConfig = widget.reference;
  const refValues: CellValue[] = [];
  if (refConfig) {
    for (const k of keys) {
      for (const row of agg.data) {
        if (typeof row[k] === "number") refValues.push(row[k]);
      }
    }
  }
  const refRange = rangeOf(refValues);

  if (agg.data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        无数据
      </div>
    );
  }

  // 表格 / 数值卡 使用聚合后的数据
  if (widget.type === "table") {
    const columns = Object.keys(agg.data[0]).map((name) => ({ name }));
    const rows = agg.data.map((d) => columns.map((c) => d[c.name]));
    return (
      <DataTable
        columns={columns}
        rows={rows}
        formats={keyFormats}
        decor={decorFor}
        searchable={false}
        pageSize={100}
      />
    );
  }

  if (widget.type === "kpi") {
    // 扁平卡片（高度较小）时数值与标签并排，避免上下堆叠被标题栏和内边距裁切
    const flat = widget.layout.h < 110;
    return (
      <div
        className={`flex h-full items-center justify-center ${flat ? "gap-3" : "gap-8"}`}
      >
        {keys.map((k, i) => {
          const total = agg.data.reduce((acc, d) => {
            const v = d[k];
            return acc + (typeof v === "number" ? v : 0);
          }, 0);
          return (
            <div
              key={k}
              className={flat ? "flex items-baseline gap-1.5" : "text-center"}
            >
              <div
                className={`font-bold tabular-nums ${flat ? "text-xl" : "text-3xl"}`}
                style={{ color: colorAt(i) }}
              >
                {formatCell(total, formatOf(k))}
              </div>
              <div
                className={
                  flat
                    ? "text-[11px] text-muted-foreground"
                    : "mt-1 text-xs text-muted-foreground"
                }
              >
                {k}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // 填充地图：自绘 SVG，不经过 Recharts
  if (widget.type === "map") {
    if (!widget.encoding.dimension) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          请将「位置」字段拖入字段井
        </div>
      );
    }
    return (
      <MapChart
        rows={agg.data}
        dimensionKey={agg.dimensionKey}
        valueKey={keys[0]}
        region={widget.mapRegion}
        showLegend={showLegend}
        highlight={highlight}
        valueFormat={formatOf(keys[0])}
        onPointClick={onPointClick}
      />
    );
  }

  // 树状图：自绘 SVG（Squarified 布局 + 两层分组），不经过 Recharts
  // 需要逐行明细，无法用聚合结果替代，截断时给出提示
  if (widget.type === "treemap") {
    return (
      <>
        <TreemapChart
          widget={widget}
          dataset={filtered}
          highlight={highlight}
          onPointClick={onPointClick}
        />
        {dataset.truncated ? (
          <PartialRowsHint shown={dataset.rows.length} total={dataset.rowCount} />
        ) : null}
      </>
    );
  }

  // 分解树：自绘列式树（按维度逐层拆分），不经过 Recharts
  if (widget.type === "decomposition") {
    return (
      <>
        <DecompositionTree
          widget={widget}
          dataset={filtered}
          filters={filters}
          crossFilter={crossFilter}
          onChange={onWidgetChange}
        />
        {dataset.truncated ? (
          <PartialRowsHint shown={dataset.rows.length} total={dataset.rowCount} />
        ) : null}
      </>
    );
  }

  const type = widget.type;

  // 数据透视表：自绘交叉表，不经过 Recharts
  if (type === "matrix") {
    if (!widget.encoding.dimension) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          请将「行」字段拖入字段井
        </div>
      );
    }
    return (
      <PivotTable
        rows={agg.data}
        dimensionKey={agg.dimensionKey}
        columnKeys={keys}
        showTotals={widget.showTotals ?? true}
        highlight={highlight}
        formats={keyFormats}
        decor={decorFor}
        onPointClick={onPointClick}
      />
    );
  }

  const chartData =
    type === "stackedBar100" ? normalizeToPercent(agg.data, keys) : agg.data;

  const categoryKey = agg.dimensionKey;
  const valueKey = keys[0];
  /** 数值轴刻度：按首个度量的格式显示 */
  const tickFormat = (v: number | string) => formatNumber(Number(v), formatOf(valueKey));
  /** 数值轴宽度：按最大刻度的文字长度自适应，避免十万级以上的刻度被截断 */
  const maxTickValue = agg.data.reduce(
    (max, row) => Math.max(max, Number(row[valueKey]) || 0),
    0,
  );
  const yAxisWidth = Math.min(96, Math.max(48, String(tickFormat(maxTickValue)).length * 6.8 + 16));

  /**
   * 类别 + 各数值 + 占该列合计百分比的统一工具提示
   *
   * 注意：Recharts 2.x 用 react-is 判断子元素类型，而 react-is 16/18 不认识 React 19
   * 的元素类型（`$$typeof` 变为 `react.transitional.element`），导致子元素被包在
   * Fragment 里时整段被忽略（坐标轴 / 网格 / 图例全部不渲染）。
   * 因此这里不返回 Fragment，而是返回带 key 的数组，由调用方直接展开。
   */
  const categoryTooltip = (key: string) => (
    <Tooltip
      key={key}
      content={
        <ChartTooltip
          categoryKey={categoryKey}
          keys={keys}
          formatOf={formatOf}
          totalOf={totalOf}
          percent={type === "stackedBar100"}
          labelOf={categoryLabel}
        />
      }
    />
  );
  /** 单值类图表（饼图 / 散点）：只有一个数值列 */
  const singleTooltip = (key: string) => (
    <Tooltip
      key={key}
      content={
        <ChartTooltip
          categoryKey={categoryKey}
          keys={[valueKey]}
          formatOf={formatOf}
          totalOf={totalOf}
          labelOf={categoryLabel}
        />
      }
    />
  );
  /** 漏斗 / 径向条形图的数据是 {name, value}，没有维度列 */
  const namedTooltip = (key: string) => (
    <Tooltip
      key={key}
      content={
        <ChartTooltip
          categoryKey="name"
          keys={["value"]}
          formatOf={(k) => formatOf(k === "value" ? valueKey : k)}
          totalOf={() => 0}
        />
      }
    />
  );
  /** 单值类图表（漏斗图 / 径向条形图）的 {name, value} 数据 */
  const namedData = agg.data.map((d) => ({
    name: String(d[categoryKey] ?? ""),
    value: typeof d[valueKey] === "number" ? d[valueKey] : 0,
  }));

  /** 参考线取值：统计量按当前数据计算；目标值 / 固定值直接取配置 */
  const referenceValue = (line: ReferenceLineConfig): number | null => {
    switch (line.kind) {
      case "avg":
        return refRange?.avg ?? null;
      case "median":
        return refRange?.median ?? null;
      case "max":
        return refRange?.max ?? null;
      case "min":
        return refRange?.min ?? null;
      default:
        return typeof line.value === "number" ? line.value : null;
    }
  };
  const KIND_LABEL: Record<ReferenceLineConfig["kind"], string> = {
    avg: "均值",
    median: "中位数",
    max: "最大",
    min: "最小",
    target: "目标",
    value: "参考",
  };

  /**
   * 参考线标签：贴在线上方并带白色描边，
   * 多条参考线数值接近时按序号横向错开，避免标签互相压字。
   */
  const refLineLabel = (index: number, color: string, axis: "x" | "y") => ({
    content: (props: { viewBox?: unknown; value?: string | number }) => {
      const vb = (props.viewBox ?? {}) as { x?: number; y?: number; width?: number };
      const x0 = typeof vb.x === "number" ? vb.x : 0;
      const y0 = typeof vb.y === "number" ? vb.y : 0;
      const width = typeof vb.width === "number" ? vb.width : 240;
      const step = Math.min(104, Math.max(0, width / 3));
      const tx = axis === "y" ? x0 + 4 + index * step : x0 + 4;
      const ty = axis === "y" ? y0 - 4 : y0 + 12 + index * 12;
      return (
        <text
          x={tx}
          y={ty}
          fontSize={10}
          fill={color}
          stroke="#fff"
          strokeWidth={2.5}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {props.value}
        </text>
      );
    },
  });

  /**
   * 参考线 / 目标带节点。
   * axis 为数值轴方向：普通图表数值在 Y 轴，条形图（layout=vertical）在 X 轴。
   */
  function referenceNodes(axis: "x" | "y"): ReactNode[] {
    const nodes: ReactNode[] = [];
    if (!refConfig) return nodes;
    for (const band of refConfig.bands ?? []) {
      if (!Number.isFinite(band.from) || !Number.isFinite(band.to)) continue;
      const pos =
        axis === "y"
          ? { y1: band.from, y2: band.to }
          : { x1: band.from, x2: band.to };
      nodes.push(
        <ReferenceArea
          key={`band-${band.id}`}
          {...pos}
          fill={band.color}
          fillOpacity={Math.min(1, Math.max(0, band.opacity / 100))}
          stroke="none"
          ifOverflow="extendDomain"
          label={
            band.label
              ? {
                  value: band.label,
                  position: "insideTopLeft",
                  fontSize: 10,
                  fill: band.color,
                }
              : undefined
          }
        />,
      );
    }
    for (const [index, line] of (refConfig.lines ?? []).entries()) {
      const value = referenceValue(line);
      if (value === null) continue;
      const pos = axis === "y" ? { y: value } : { x: value };
      const text =
        line.label?.trim() ||
        `${KIND_LABEL[line.kind]} ${formatNumber(value, formatOf(valueKey))}`;
      nodes.push(
        <ReferenceLine
          key={`line-${line.id}`}
          {...pos}
          stroke={line.color}
          strokeWidth={1.5}
          strokeDasharray={line.dashed ? "4 4" : undefined}
          ifOverflow="extendDomain"
          label={{ ...refLineLabel(index, line.color, axis), value: text }}
        />,
      );
    }
    return nodes;
  }

  const cartesianAxes = [
    <CartesianGrid key="grid" strokeDasharray="3 3" className="stroke-muted" />,
    ...referenceNodes("y"),
    <XAxis
      key="x"
      dataKey={categoryKey}
      tick={{ fontSize: 11 }}
      tickFormatter={categoryLabel}
      interval="preserveStartEnd"
    />,
    <YAxis key="y" tick={{ fontSize: 11 }} width={yAxisWidth} tickFormatter={tickFormat} />,
    categoryTooltip("tooltip"),
    showLegend ? <Legend key="legend" wrapperStyle={{ fontSize: 12 }} /> : null,
  ];

  const horizontalAxes = [
    <CartesianGrid key="grid" strokeDasharray="3 3" className="stroke-muted" />,
    ...referenceNodes("x"),
    <XAxis key="x" type="number" tick={{ fontSize: 11 }} tickFormatter={tickFormat} />,
    <YAxis
      key="y"
      type="category"
      dataKey={categoryKey}
      tick={{ fontSize: 11 }}
      tickFormatter={categoryLabel}
      width={72}
    />,
    categoryTooltip("tooltip"),
    showLegend ? <Legend key="legend" wrapperStyle={{ fontSize: 12 }} /> : null,
  ];

  const margin = { top: 8, right: 8, left: 0, bottom: 0 };

  /** 取值分类标签（维度字段标签） */
  const categoryOf = (row: Record<string, string | number | null>) =>
    String(row[categoryKey] ?? "");

  // 层级轴：X 轴字段 → 钻取井字段；`level` 为当前展示到的最末层下标
  const drill = widget.drill;
  const fields = hierarchyFields(widget.encoding, widget.drill);
  const lastShown = dimensions[dimensions.length - 1];
  const level = Math.max(0, lastShown ? fields.indexOf(lastShown) : 0);
  const canDrillDown = Boolean(onWidgetChange && level < fields.length - 1);
  /** 已在顶层（未下钻）时上钻无意义 */
  const canDrillUp = Boolean(drill && drill.level > 0);
  const interactive = Boolean(onPointClick) || canDrillDown;

  /** 多级类别标签 → 各层原始值（单级分组时就是标签本身） */
  const partsOfLabel = (label: string): string[] =>
    agg.dimensionPaths?.[label] ?? [label];
  /** 当前层的最末字段（交叉筛选使用叶子字段与值，合成标签不参与筛选） */
  const leafField = dimensions[dimensions.length - 1] ?? widget.encoding.dimension ?? "";

  function handlePointActivate(label: string, additive: boolean) {
    const parts = partsOfLabel(label);
    const leafValue = parts[parts.length - 1] ?? label;

    if (onWidgetChange && canDrillDown && !additive && label !== OTHERS_LABEL) {
      // 多级展示时点击叶子节点 → 聚焦到该节点路径并下钻下一层
      const multiLevel = dimensions.length > 1;
      onWidgetChange({
        drill: {
          path: drill?.path ?? [],
          level: multiLevel ? parts.length : level + 1,
          selections: multiLevel
            ? parts
            : [...(drill?.selections.slice(0, level) ?? []), leafValue],
          mode: "drill",
        },
      });
      return;
    }
    onPointClick?.(leafField, leafValue, additive);
  }

  /** 依据高亮状态生成单个图元的填充与点击属性（label 为类别标签） */
  function pointProps(
    label: string,
    fill: string,
    value?: CellValue,
    key?: string,
  ) {
    const parts = partsOfLabel(label);
    const leafValue = parts[parts.length - 1] ?? label;
    const opacity = cellOpacity(highlight, leafField, leafValue);
    // 条件格式：色阶 / 规则命中时覆盖系列默认色（柱形图）
    const target = key ?? valueKey;
    const override =
      conditional && appliesTo(conditional, target)
        ? chartFill(value ?? null, rangeFor(target), conditional)
        : undefined;
    return {
      fill: override ?? fill,
      fillOpacity: opacity,
      className: interactive ? "cursor-pointer" : undefined,
      onClick: interactive
        ? (e: MouseEvent) => handlePointActivate(label, e.metaKey || e.ctrlKey)
        : undefined,
    };
  }

  function renderChart() {
    switch (type) {
      case "bar":
        return (
          <BarChart data={chartData} margin={margin}>
            {cartesianAxes}
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} radius={[3, 3, 0, 0]}>
                {chartData.map((row, ri) => (
                  <Cell
                    key={ri}
                    {...pointProps(categoryOf(row), colorAt(i), row[k], k)}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        );
      case "stackedBar":
      case "stackedBar100":
        return (
          <BarChart data={chartData} margin={margin}>
            {cartesianAxes}
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="a">
                {chartData.map((row, ri) => (
                  <Cell
                    key={ri}
                    {...pointProps(categoryOf(row), colorAt(i), row[k], k)}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        );
      case "horizontalBar":
        return (
          <BarChart data={chartData} layout="vertical" margin={margin}>
            {horizontalAxes}
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} radius={[0, 3, 3, 0]}>
                {chartData.map((row, ri) => (
                  <Cell
                    key={ri}
                    {...pointProps(categoryOf(row), colorAt(i), row[k], k)}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        );
      case "horizontalStackedBar":
        return (
          <BarChart data={chartData} layout="vertical" margin={margin}>
            {horizontalAxes}
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="a">
                {chartData.map((row, ri) => (
                  <Cell
                    key={ri}
                    {...pointProps(categoryOf(row), colorAt(i), row[k], k)}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        );
      case "line":
        return (
          <LineChart data={chartData} margin={margin}>
            {cartesianAxes}
            {keys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                stroke={colorAt(i)}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        );
      case "area":
        return (
          <AreaChart data={chartData} margin={margin}>
            {cartesianAxes}
            {keys.map((k, i) => (
              <Area
                key={k}
                type="monotone"
                dataKey={k}
                stroke={colorAt(i)}
                fill={colorAt(i)}
                fillOpacity={0.25}
              />
            ))}
          </AreaChart>
        );
      case "stackedArea":
        return (
          <AreaChart data={chartData} margin={margin}>
            {cartesianAxes}
            {keys.map((k, i) => (
              <Area
                key={k}
                type="monotone"
                dataKey={k}
                stackId="a"
                stroke={colorAt(i)}
                fill={colorAt(i)}
                fillOpacity={0.5}
              />
            ))}
          </AreaChart>
        );
      case "combo":
        return (
          <ComposedChart data={chartData} margin={margin}>
            {cartesianAxes}
            {keys.map((k, i) =>
              i === 0 ? (
                <Bar key={k} dataKey={k} radius={[3, 3, 0, 0]}>
                  {chartData.map((row, ri) => (
                    <Cell
                      key={ri}
                      {...pointProps(categoryOf(row), colorAt(i), row[k], k)}
                    />
                  ))}
                </Bar>
              ) : (
                <Line
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stroke={colorAt(i)}
                  strokeWidth={2}
                  dot={false}
                />
              ),
            )}
          </ComposedChart>
        );
      case "pie":
      case "donut":
        return (
          <PieChart>
            {singleTooltip("tooltip")}
            {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
            <Pie
              data={agg.data}
              dataKey={valueKey}
              nameKey={categoryKey}
              cx="50%"
              cy="50%"
              innerRadius={type === "donut" ? "45%" : 0}
              outerRadius="70%"
              label={(p: PieLabelRenderProps) =>
                formatNumber(Number(p.value), formatOf(valueKey))
              }
            >
              {agg.data.map((row, i) => (
                <Cell
                  key={i}
                  {...pointProps(categoryOf(row), colorAt(i))}
                />
              ))}
            </Pie>
          </PieChart>
        );
      case "scatter":
        return (
          <ScatterChart margin={margin}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey={categoryKey}
              type="number"
              tick={{ fontSize: 11 }}
              name={categoryKey}
            />
            <YAxis
              dataKey={valueKey}
              type="number"
              tick={{ fontSize: 11 }}
              width={48}
              tickFormatter={tickFormat}
            />
            {singleTooltip("tooltip")}
            <Scatter data={agg.data} fill={colorAt(0)} />
          </ScatterChart>
        );
      case "funnel":
        return (
          <FunnelChart>
            {namedTooltip("tooltip")}
            <Funnel
              data={namedData}
              dataKey="value"
              nameKey="name"
              isAnimationActive={false}
            >
              {namedData.map((d, i) => (
                <Cell key={i} {...pointProps(d.name, colorAt(i))} />
              ))}
            </Funnel>
          </FunnelChart>
        );
      case "radialBar":
        return (
          <RadialBarChart
            data={namedData}
            innerRadius="30%"
            outerRadius="95%"
            startAngle={90}
            endAngle={-270}
          >
            <RadialBar dataKey="value" background>
              {namedData.map((d, i) => (
                <Cell key={i} {...pointProps(d.name, colorAt(i))} />
              ))}
            </RadialBar>
            {namedTooltip("tooltip")}
            {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          </RadialBarChart>
        );
      default:
        return <></>;
    }
  }

  return (
    <div className="relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        {renderChart()}
      </ResponsiveContainer>
      {onWidgetChange && fields.length > 1 && (canDrillUp || canDrillDown) ? (
        <DrillBreadcrumb
          fields={fields}
          level={level}
          selections={drill?.selections ?? []}
          canDrillUp={canDrillUp}
          canExpand={canDrillDown}
          onNavigate={(next) =>
            onWidgetChange({
              drill: {
                path: drill?.path ?? [],
                level: next,
                selections: (drill?.selections ?? []).slice(0, next),
                mode: "drill",
              },
            })
          }
          onExpand={() =>
            onWidgetChange({
              drill: {
                path: drill?.path ?? [],
                level: level + 1,
                selections: (drill?.selections ?? []).slice(0, level),
                mode: "expand",
              },
            })
          }
        />
      ) : null}
    </div>
  );
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  label?: unknown;
  /** 分类字段名（饼图为维度列，漏斗/径向为 name） */
  categoryKey: string;
  /** 需要展示的数值列 */
  keys: string[];
  formatOf: (key: string) => FieldFormat | undefined;
  /** 某一数值列的合计（用于占比） */
  totalOf: (key: string) => number;
  /** 百分比堆叠图：数值已是百分比 */
  percent?: boolean;
  /** 类别标签格式化（日期维度转短日期） */
  labelOf?: (value: string) => string;
}

/** 统一工具提示：类别 + 各数值 + 占该列合计的百分比（单数值列时显示） */
function ChartTooltip({
  active,
  payload,
  label,
  categoryKey,
  keys,
  formatOf,
  totalOf,
  percent,
  labelOf,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = (payload[0]?.payload ?? {}) as Record<string, string | number | null>;
  const rawCategory =
    label === undefined || label === null
      ? String(datum[categoryKey] ?? "")
      : String(label);
  const category = rawCategory && labelOf ? labelOf(rawCategory) : rawCategory;

  const entries = keys
    .map((key) => ({ key, value: datum[key] }))
    .filter((e): e is { key: string; value: number } => typeof e.value === "number");
  if (entries.length === 0) return null;

  const showShare = !percent && keys.length === 1;
  return (
    <div className="min-w-[96px] rounded-md border bg-background/95 px-2 py-1.5 text-[11px] shadow-md">
      {category ? <div className="mb-1 truncate font-medium">{category}</div> : null}
      {entries.map((entry) => {
        const total = totalOf(entry.key);
        return (
          <div key={entry.key} className="flex items-center justify-between gap-3 py-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: colorAt(keys.indexOf(entry.key)) }}
              />
              <span className="truncate text-muted-foreground">{entry.key}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {percent
                ? `${entry.value.toFixed(1)}%`
                : formatCell(entry.value, formatOf(entry.key))}
            </span>
            {showShare && total > 0 ? (
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                {((entry.value / total) * 100).toFixed(1)}%
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 钻取面包屑：显示上钻路径，点击任一层回到该层；末尾可展开下一级别 */
function DrillBreadcrumb({
  fields,
  level,
  selections,
  canDrillUp,
  canExpand,
  onNavigate,
  onExpand,
}: {
  /** 完整层级：X 轴字段 → 钻取井字段 */
  fields: string[];
  /** 当前展示到的最末层下标 */
  level: number;
  /** 已选中的各层取值（第 i 项对应 fields[i]） */
  selections: string[];
  /** 是否处于下钻状态（顶层时上钻无意义，按钮禁用） */
  canDrillUp: boolean;
  /** 是否还有下一层可展开 */
  canExpand: boolean;
  /** 回到第 next 层（next 为展示层下标） */
  onNavigate: (next: number) => void;
  /** 展开下一级别（当前层 + 全部下一层子项） */
  onExpand: () => void;
}) {
  const safeLevel = Math.min(Math.max(level, 0), Math.max(fields.length - 1, 0));
  const crumbs = selections.slice(0, Math.min(safeLevel, selections.length));
  const fieldOf = (i: number) => fields[i] ?? "";
  return (
    <div className="absolute left-0 top-0 z-10 flex max-w-full flex-wrap items-center gap-0.5 rounded-br-md bg-background/90 px-1 py-0.5 text-[10px] text-muted-foreground shadow-sm">
      <button
        type="button"
        title="上钻"
        aria-label="上钻"
        disabled={!canDrillUp || safeLevel === 0}
        onClick={() => onNavigate(Math.max(0, safeLevel - 1))}
        className="flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <ChevronUp className="h-3 w-3" />
        上钻
      </button>
      {crumbs.map((value, i) => (
        <span key={`${fieldOf(i)}-${i}`} className="flex items-center gap-0.5">
          <span className="text-border">/</span>
          <button
            type="button"
            title={`${fieldOf(i)}：${value}`}
            onClick={() => onNavigate(i + 1)}
            className="max-w-[120px] truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
          >
            {value}
          </button>
        </span>
      ))}
      <span className="px-1 text-foreground/60">{fieldOf(safeLevel)}</span>
      {canExpand ? (
        <button
          type="button"
          title="展开下一级别"
          aria-label="展开下一级别"
          onClick={onExpand}
          className="flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" />
          展开
        </button>
      ) : null}
    </div>
  );
}

/** 截断提示：树状图 / 分解树需要逐行明细，只能用已取回的部分行 */
function PartialRowsHint({ shown, total }: { shown: number; total?: number }) {
  return (
    <div className="pointer-events-none absolute bottom-1 right-1 z-10 rounded bg-background/85 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm">
      基于前 {shown.toLocaleString()} 行
      {total && total > shown ? ` / 共 ${total.toLocaleString()} 行` : ""}
    </div>
  );
}
