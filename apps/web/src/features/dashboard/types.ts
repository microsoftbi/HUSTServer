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
  | 'decomposition'
  | 'funnel'
  | 'radialBar'
  | 'table'
  | 'kpi'
  | 'map'
  | 'matrix'
  /** 切片器视觉对象：本身不画图，直接承载值选择与筛选 */
  | 'filter';

/** 切片器类型（对齐 Power BI 切片器的可用样式） */
export type SlicerType =
  | 'list'
  | 'dropdown'
  | 'between'
  | 'before'
  | 'after'
  | 'relativeDate'
  | 'hierarchy';

export type SlicerSelectionMode = 'single' | 'multi';
export type SlicerRelativeUnit = 'day' | 'week' | 'month' | 'year';
export type SlicerRelativeDirection = 'last' | 'next';

/** 介于/之前/之后 使用的区间输入（字符串便于直接绑定日期与数字输入框） */
export interface SlicerRange {
  min?: string;
  max?: string;
}

export interface SlicerRelative {
  direction: SlicerRelativeDirection;
  count: number;
  unit: SlicerRelativeUnit;
}

/** 切片器的筛选状态（随仪表板一起落库，与 Power BI 一致） */
export interface SlicerState {
  /** 字段 → 选中的标签值；空数组表示「全部」 */
  selections: Record<string, string[]>;
  /** 字段 → 区间（介于/之前/之后） */
  ranges: Record<string, SlicerRange>;
  /** 相对日期配置 */
  relative: SlicerRelative;
}

/** 切片器的外观与交互配置 */
export interface SlicerConfig {
  type: SlicerType;
  selectionMode: SlicerSelectionMode;
  /** 列表中显示「全选」项 */
  showSelectAll: boolean;
  /** 列表/下拉中显示搜索框 */
  searchable: boolean;
  showHeader: boolean;
  headerText?: string;
  /** 列表项水平排列 */
  horizontal: boolean;
  showBorder: boolean;
  accentColor: string;
  backgroundColor: string;
  fontColor: string;
  fontSize: number;
  state: SlicerState;
}

export type MapRegion = 'auto' | 'china' | 'world';
export type AggregateFn = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'none';

/** 树状图配色方式：按类别（或详细信息）取色、按值渐变、单色 */
export type TreemapColorMode = 'category' | 'value' | 'single';

/** 树状图的外观配置（对齐 Power BI 树状图格式窗格） */
export interface TreemapConfig {
  colorMode: TreemapColorMode;
  /** 单色 / 按值渐变时使用的基础颜色 */
  baseColor: string;
  /** 分组标题（类别名） */
  showCategoryLabels: boolean;
  /** 图块内的值标签 */
  showValueLabels: boolean;
  labelColor: string;
  /** 标签最大字号，空间不足时自动缩小 */
  labelFontSize: number;
  showBorder: boolean;
  /** 分组之间的间距（像素） */
  groupPadding: number;
}

/** 分解树节点展开方式：AI 拆分（高值 / 低值）在配置中以特殊字段名保存 */
export type DecompositionSplit = '__ai_high__' | '__ai_low__';

/** 分解树的外观配置（对齐 Power BI 分解树格式窗格） */
export interface DecompositionConfig {
  /** 数据条颜色 */
  baseColor: string;
  showBars: boolean;
  showValues: boolean;
  /** 每列顶部的级别标题（拆分字段名） */
  showLevelHeaders: boolean;
  showConnectors: boolean;
  /** 展开菜单中提供「高值 / 低值」自动拆分 */
  aiSplits: boolean;
  labelColor: string;
  fontSize: number;
  /** 每个级别显示的最大节点数 */
  maxBars: number;
  /** 节点路径 → 展开依据字段（特殊值见 DecompositionSplit） */
  expansions: Record<string, string>;
}

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
  /** 仅树状图使用：配色、标签与间距配置 */
  treemap?: TreemapConfig;
  /** 仅分解树使用：可依次用于展开节点的维度字段 */
  explainBy?: string[];
  /** 仅分解树使用：外观与展开状态 */
  decomposition?: DecompositionConfig;
  /** 仅切片器使用：被拖入的字段名（多个字段即层次结构切片器） */
  filterFields?: string[];
  /** 仅切片器使用：外观与交互配置 */
  slicer?: SlicerConfig;
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
