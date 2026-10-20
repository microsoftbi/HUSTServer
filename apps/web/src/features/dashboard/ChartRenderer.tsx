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
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartWidget, Dataset } from "@bi/types";
import { aggregate } from "@bi/lib/aggregate";
import { colorAt, normalizeToPercent } from "@bi/lib/chart";
import { DataTable } from "@bi/components/DataTable";
import { MapChart } from "./MapChart";
import { PivotTable } from "./PivotTable";
import { formatCell } from "@bi/lib/format";
import {
  cellOpacity,
  filterDataset,
  type CrossFilter,
  type HighlightSelection,
} from "@bi/lib/highlight";
import type { MouseEvent } from "react";

interface ChartRendererProps {
  widget: ChartWidget;
  dataset: Dataset | undefined;
  /** 当前交叉高亮状态（瞬时态，不参与聚合） */
  highlight?: HighlightSelection | null;
  /** 来自其它视觉对象的交叉筛选条件（源视觉对象自身不传） */
  crossFilter?: CrossFilter | null;
  /** 点击图元回调：field 为分组字段，value 为标签值，additive 表示 ⌘/Ctrl 多选 */
  onPointClick?: (field: string, value: string, additive: boolean) => void;
}

export function ChartRenderer({
  widget,
  dataset,
  highlight = null,
  crossFilter = null,
  onPointClick,
}: ChartRendererProps) {
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

  // 交叉筛选：按其它视觉对象选中的维度值过滤行，再重新聚合
  const agg = aggregate(filterDataset(dataset, crossFilter), widget.encoding);
  const keys = agg.series.length > 0 ? agg.series : agg.measureKeys;
  const showLegend = widget.showLegend ?? true;

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
      <DataTable columns={columns} rows={rows} searchable={false} pageSize={100} />
    );
  }

  if (widget.type === "kpi") {
    return (
      <div className="flex h-full items-center justify-center gap-8">
        {keys.map((k, i) => {
          const total = agg.data.reduce((acc, d) => {
            const v = d[k];
            return acc + (typeof v === "number" ? v : 0);
          }, 0);
          return (
            <div key={k} className="text-center">
              <div
                className="text-3xl font-bold tabular-nums"
                style={{ color: colorAt(i) }}
              >
                {formatCell(total)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{k}</div>
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
        onPointClick={onPointClick}
      />
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
        onPointClick={onPointClick}
      />
    );
  }

  const chartData =
    type === "stackedBar100" ? normalizeToPercent(agg.data, keys) : agg.data;

  const categoryKey = agg.dimensionKey;
  const valueKey = keys[0];
  /** 单值类图表（树状图 / 漏斗图 / 径向条形图）的 {name, value} 数据 */
  const namedData = agg.data.map((d) => ({
    name: String(d[categoryKey] ?? ""),
    value: typeof d[valueKey] === "number" ? d[valueKey] : 0,
  }));

  const cartesianAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
      <XAxis
        dataKey={categoryKey}
        tick={{ fontSize: 11 }}
        interval="preserveStartEnd"
      />
      <YAxis tick={{ fontSize: 11 }} width={48} />
      <Tooltip />
      {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
    </>
  );

  const horizontalAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
      <XAxis type="number" tick={{ fontSize: 11 }} />
      <YAxis
        type="category"
        dataKey={categoryKey}
        tick={{ fontSize: 11 }}
        width={72}
      />
      <Tooltip />
      {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
    </>
  );

  const margin = { top: 8, right: 8, left: 0, bottom: 0 };

  /** 取值分类标签（维度字段标签） */
  const categoryOf = (row: Record<string, string | number | null>) =>
    String(row[categoryKey] ?? "");

  /** 依据高亮状态生成单个图元的填充与点击属性 */
  function pointProps(field: string, value: string, fill: string) {
    const opacity = cellOpacity(highlight, field, value);
    return {
      fill,
      fillOpacity: opacity,
      className: onPointClick ? "cursor-pointer" : undefined,
      onClick: onPointClick
        ? (e: MouseEvent) => onPointClick(field, value, e.metaKey || e.ctrlKey)
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
                    {...pointProps(categoryKey, categoryOf(row), colorAt(i))}
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
                    {...pointProps(categoryKey, categoryOf(row), colorAt(i))}
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
                    {...pointProps(categoryKey, categoryOf(row), colorAt(i))}
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
                    {...pointProps(categoryKey, categoryOf(row), colorAt(i))}
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
                      {...pointProps(categoryKey, categoryOf(row), colorAt(i))}
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
            <Tooltip />
            {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
            <Pie
              data={agg.data}
              dataKey={valueKey}
              nameKey={categoryKey}
              cx="50%"
              cy="50%"
              innerRadius={type === "donut" ? "45%" : 0}
              outerRadius="70%"
              label
            >
              {agg.data.map((row, i) => (
                <Cell
                  key={i}
                  {...pointProps(categoryKey, categoryOf(row), colorAt(i))}
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
            <YAxis dataKey={valueKey} type="number" tick={{ fontSize: 11 }} width={48} />
            <Tooltip />
            <Scatter data={agg.data} fill={colorAt(0)} />
          </ScatterChart>
        );
      case "treemap":
        return (
          <Treemap
            data={namedData}
            dataKey="value"
            nameKey="name"
            stroke="#fff"
            isAnimationActive={false}
          >
            {namedData.map((d, i) => (
              <Cell key={i} {...pointProps(categoryKey, d.name, colorAt(i))} />
            ))}
          </Treemap>
        );
      case "funnel":
        return (
          <FunnelChart>
            <Tooltip />
            <Funnel
              data={namedData}
              dataKey="value"
              nameKey="name"
              isAnimationActive={false}
            >
              {namedData.map((d, i) => (
                <Cell key={i} {...pointProps(categoryKey, d.name, colorAt(i))} />
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
                <Cell key={i} {...pointProps(categoryKey, d.name, colorAt(i))} />
              ))}
            </RadialBar>
            <Tooltip />
            {showLegend ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          </RadialBarChart>
        );
      default:
        return <></>;
    }
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      {renderChart()}
    </ResponsiveContainer>
  );
}
