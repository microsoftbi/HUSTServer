// 视觉对象的「查看数据 / 导出数据」：按图表当前的筛选与聚合口径还原一张二维表，
// 与画布上显示的数字保持一致（切片器 / 页 / 报表 / 视觉对象筛选全部生效）。

import type { CellValue, ChartWidget, Dataset } from "@bi/types";
import { applyViewOptions, aggregate, effectiveDimensions } from "./aggregate";
import {
  applyValueFilters,
  drillValueFilters,
  filterDataset,
  type ValueFilter,
} from "./highlight";

export interface WidgetTable {
  headers: string[];
  rows: CellValue[][];
}

const EMPTY: WidgetTable = { headers: [], rows: [] };

export function widgetTable(
  widget: ChartWidget,
  dataset: Dataset | undefined,
  filters: ValueFilter[],
): WidgetTable {
  if (!dataset || widget.encoding.measures.length === 0) return EMPTY;
  const filtered = filterDataset(
    applyValueFilters(dataset, [...filters, ...drillValueFilters(widget)]),
    null,
  );
  const agg = applyViewOptions(
    aggregate(
      filtered,
      widget.encoding,
      effectiveDimensions(widget.encoding, widget.drill),
    ),
    { sort: widget.sort, topN: widget.topN },
  );
  const keys = agg.series.length > 0 ? agg.series : agg.measureKeys;
  if (keys.length === 0) return EMPTY;
  const headers = [agg.dimensionKey, ...keys];
  const rows = agg.data.map((datum) =>
    headers.map((key) => (datum[key] ?? null) as CellValue),
  );
  return { headers, rows };
}
