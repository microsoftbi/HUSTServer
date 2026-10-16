export type CellValue = string | number | boolean | null;
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

export interface Column {
  name: string;
  type: ColumnType;
}

export type ChartType =
  | 'bar'
  | 'stackedBar'
  | 'stackedBar100'
  | 'horizontalBar'
  | 'horizontalStackedBar'
  | 'line'
  | 'area'
  | 'stackedArea'
  | 'combo'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'treemap'
  | 'funnel'
  | 'radialBar'
  | 'table'
  | 'kpi'
  | 'map'
  | 'matrix';

export type MapRegion = 'auto' | 'china' | 'world';
export type AggregateFn = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'none';

export interface Measure {
  field: string;
  agg: AggregateFn;
}

export interface WidgetEncoding {
  dimension?: string;
  measures: Measure[];
  series?: string;
}

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChartWidget {
  id: string;
  type: ChartType;
  title: string;
  datasetId: string;
  encoding: WidgetEncoding;
  layout: WidgetLayout;
  showTitle?: boolean;
  showLegend?: boolean;
  mapRegion?: MapRegion;
  showTotals?: boolean;
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: ChartWidget[];
}

export interface QueryColumn {
  name: string;
  type: ColumnType;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: CellValue[][];
  truncated: boolean;
}

export type DatasetSource = 'csv' | 'excel' | 'sql' | 'model';

export type DatasetDef =
  | { kind: 'sql'; connectionId: string; query: string }
  | { kind: 'file'; resourcePath: string; format: 'csv' | 'excel' }
  | { kind: 'model'; modelName: string };

/** 落库的最小单元：只有定义，没有行数据。 */
export interface SavedDataset {
  id: string;
  name: string;
  def: DatasetDef;
}

/** 运行时数据集：在 tinybi 的 Dataset 上多带 def，便于回写定义。 */
export interface Dataset {
  id: string;
  name: string;
  source: DatasetSource;
  columns: Column[];
  rows: CellValue[][];
  createdAt: string;
  def: DatasetDef;
}

/** 落库的 JSON 结构。 */
export interface DashboardPayload {
  version: 2;
  dashboards: Dashboard[];
  activeId: string;
  datasets: SavedDataset[];
}
