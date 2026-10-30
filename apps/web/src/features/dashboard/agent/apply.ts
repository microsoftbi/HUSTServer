// 把生成规格转成画布上的视觉对象：只做字段映射与默认样式，不改动已有对象。

import { defaultSlicerFor } from "@bi/lib/slicer";
import { uid } from "@bi/lib/utils";
import type {
  ChartType,
  ChartWidget,
  Column,
  Measure,
  SlicerType,
  WidgetLayout,
} from "@bi/types";
import { layoutSpec } from "./layout";
import type { DashboardSpec, SpecChart } from "./types";

/** 服务端已按白名单校验，这里再做一次类型收窄，避免脏数据进入画布 */
const CHART_TYPES: readonly string[] = [
  "bar",
  "stackedBar",
  "horizontalBar",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "treemap",
  "funnel",
  "table",
  "kpi",
  "matrix",
];

const SLICER_TYPES: readonly string[] = [
  "list",
  "dropdown",
  "between",
  "before",
  "after",
  "relativeDate",
  "hierarchy",
];

function measuresOf(chart: SpecChart): Measure[] {
  return chart.measures.map((m) => ({ field: m.field, agg: m.agg }));
}

function chartWidget(chart: SpecChart, datasetId: string, layout: WidgetLayout): ChartWidget {
  const type = (CHART_TYPES.includes(chart.type) ? chart.type : "bar") as ChartType;
  return {
    id: uid("w"),
    type,
    title: chart.title,
    datasetId,
    encoding: {
      ...(chart.dimension ? { dimension: chart.dimension } : {}),
      measures: measuresOf(chart),
    },
    layout,
  };
}

/**
 * 生成要追加到当前页的视觉对象（顺序：切片器 → 数据卡片 → 图表）。
 * occupied 传入当前页已有对象，用于把新对象排到它们下方。
 */
export function buildWidgets(
  spec: DashboardSpec,
  datasetId: string,
  columns: Column[],
  occupied: Array<{ layout: WidgetLayout }> = [],
): ChartWidget[] {
  const layout = layoutSpec(spec, occupied);
  const columnType = (field: string) => columns.find((c) => c.name === field)?.type ?? "string";

  const slicers: ChartWidget[] = spec.slicers.map((slicer, i) => {
    const base = defaultSlicerFor(columnType(slicer.field));
    const type = (SLICER_TYPES.includes(slicer.type ?? "") ? slicer.type : base.type) as SlicerType;
    return {
      id: uid("w"),
      type: "filter",
      title: "切片器",
      datasetId,
      encoding: { measures: [] },
      layout: layout.slicers[i],
      filterFields: [slicer.field],
      slicer: { ...base, type },
    };
  });

  const kpis: ChartWidget[] = spec.kpis.map((kpi, i) => ({
    id: uid("w"),
    type: "kpi",
    title: kpi.title,
    datasetId,
    encoding: { measures: [{ field: kpi.field, agg: kpi.agg }] },
    layout: layout.kpis[i],
  }));

  const charts: ChartWidget[] = spec.charts.map((chart, i) =>
    chartWidget(chart, datasetId, layout.charts[i]),
  );

  return [...slicers, ...kpis, ...charts];
}
