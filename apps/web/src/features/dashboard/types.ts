export type CellValue = string | number | boolean | null;
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

export interface Column {
  name: string;
  type: ColumnType;
}

/** 数值显示单位：按数量级折算后再拼接后缀 */
export type NumberUnit = 'none' | 'thousand' | 'tenThousand' | 'million' | 'hundredMillion';

/** 字段级数值格式（对应 Power BI 的列 / 度量值格式设置） */
export interface FieldFormat {
  /** 小数位；-1 表示自动（最多 6 位并去掉浮点尾差） */
  decimals: number;
  /** 是否使用千分位分隔 */
  thousands: boolean;
  /** 显示单位 */
  unit: NumberUnit;
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
  | 'filter'
  /** 装饰元素：不绑定数据集，只承载文本 / 图片 / 形状 / 按钮 */
  | 'text'
  | 'image'
  | 'shape'
  | 'button';

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

export type WidgetShadow = 'none' | 'sm' | 'md' | 'lg';
export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/**
 * 视觉对象的通用外观（对齐 Power BI「设置视觉对象格式 → 常规 / 效果」）。
 * 未配置时按默认值渲染，因此旧数据无需迁移。
 */
export interface WidgetStyle {
  /** 背景填充色（空字符串表示不填充） */
  background: string;
  /** 背景不透明度（0-100） */
  backgroundOpacity: number;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  /** 内容内边距（像素） */
  padding: number;
  shadow: WidgetShadow;
  titleFontSize: number;
  titleColor: string;
  titleAlign: TextAlign;
}

/** 按钮动作（对齐 Power BI「插入 → 按钮」下拉里的动作类型） */
export type ButtonAction =
  | 'back'
  | 'next'
  | 'reset'
  | 'stepBack'
  | 'info'
  | 'help'
  | 'qa'
  | 'bookmark'
  | 'blank'
  | 'applySlicers'
  | 'clearSlicers'
  | 'navigator';

/** 形状种类（分组与顺序对齐 Power BI「插入 → 形状」） */
export type ShapeKind =
  | 'rect'
  | 'roundRect'
  | 'snipRect'
  | 'diamond'
  | 'parallelogram'
  | 'ellipse'
  | 'triangle'
  | 'rightTriangle'
  | 'trapezoid'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'heart'
  | 'cross'
  | 'line'
  | 'arrowLeftRight'
  | 'arrowRight'
  | 'arrowUp'
  | 'arrowDown'
  | 'bendArrow'
  | 'chevron';

/** 装饰元素（文本框 / 图像 / 形状 / 按钮）的配置 */
export interface DecorationConfig {
  /** 文本框内容；按钮上显示的文字 */
  text: string;
  /** 按钮动作（仅 button 生效） */
  action: ButtonAction;
  fontSize: number;
  bold: boolean;
  color: string;
  align: TextAlign;
  verticalAlign: VerticalAlign;
  /** 图像地址（http(s) 或 data URI） */
  imageUrl: string;
  imageFit: 'contain' | 'cover' | 'fill';
  /** 形状种类 */
  shape: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** 圆角（矩形生效） */
  radius: number;
}

/** 页面视图缩放模式（对齐 Power BI「视图 → 页面视图」） */
export type PageViewFit = 'page' | 'width' | 'actual';

/** 筛选器卡片的筛选方式（对齐 Power BI 的筛选器类型） */
export type FilterMode = 'basic' | 'range' | 'topN';

/** 报表页设置（对齐 Power BI 的「页面设置 / 画布设置」） */
export interface PageConfig {
  /** 画布宽度；0 表示适应容器宽度 */
  width: number;
  /** 画布高度；0 表示随内容自动增高 */
  height: number;
  /** 报表页背景色 */
  background: string;
  /** 报表页背景图片地址 */
  backgroundImage: string;
  /** 画布外壁纸色（空字符串使用默认灰色） */
  wallpaper: string;
  /** 视图 → 网格线：编辑时在页面上叠加对齐网格 */
  gridlines?: boolean;
  /** 视图 → 锁定对象：禁止拖动与缩放视觉对象 */
  lockObjects?: boolean;
  /** 视图 → 页面视图：适应页面 / 适应宽度 / 实际大小 */
  pageFit?: PageViewFit;
}

/** 筛选器窗格中的一张筛选器卡片（对齐 Power BI 的筛选器条件） */
export interface FilterCondition {
  id: string;
  /** 归属数据集：只作用于该数据集上的视觉对象 */
  datasetId: string;
  field: string;
  /** 勾选要保留的值（标签归一化后）；空数组表示「全部」，即不筛选 */
  values: string[];
  /** 筛选方式：基本（值列表） / 区间 / 前 N 项 */
  mode?: FilterMode;
  /** 区间筛选的下限（数字或日期字符串） */
  min?: string;
  /** 区间筛选的上限 */
  max?: string;
  /** 前 N 项筛选的 N */
  n?: number;
  /** 锁定：禁止在筛选器窗格中修改该筛选器 */
  locked?: boolean;
  /** 隐藏：仍生效，但默认不在筛选器窗格中显示 */
  hidden?: boolean;
}

export interface ChartWidget {
  id: string;
  type: ChartType;
  title: string;
  datasetId: string;
  encoding: WidgetEncoding;
  layout: WidgetLayout;
  /** 仅本视觉对象生效的筛选器条件（此视觉对象上的筛选器） */
  filters?: FilterCondition[];
  /** 通用外观：背景、边框、圆角、阴影、标题样式 */
  style?: WidgetStyle;
  /** 装饰元素（text / image / shape）的内容配置 */
  decoration?: DecorationConfig;
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
  /** 视图 → 选择窗格：隐藏视觉对象（保留在列表中，画布与展示均不渲染） */
  hidden?: boolean;
  /** 视图 → 选择窗格 → Tab 顺序：键盘导航顺序（越小越靠前） */
  tabOrder?: number;
}

/** 书签保存的页面状态快照（对齐 Power BI 书签：筛选器 / 视觉对象可见性 / 切片器状态） */
export interface BookmarkState {
  filters: FilterCondition[];
  widgets: Array<{ id: string; hidden?: boolean; tabOrder?: number }>;
  /** 切片器视觉对象 id → 选择状态 */
  slicers: Record<string, SlicerState>;
}

export interface Bookmark {
  id: string;
  name: string;
  state: BookmarkState;
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: ChartWidget[];
  /** 页面设置：画布尺寸、背景与壁纸 */
  page?: PageConfig;
  /** 本页所有视觉对象生效的筛选器条件（此页上的筛选器） */
  filters?: FilterCondition[];
  /** 视图 → 书签：保存的页面状态 */
  bookmarks?: Bookmark[];
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
  /** 字段级数值格式：列名 → 格式 */
  formats?: Record<string, FieldFormat>;
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
  /** 字段级数值格式：列名 → 格式 */
  formats?: Record<string, FieldFormat>;
}

/** 落库的 JSON 结构。 */
export interface DashboardPayload {
  version: 2;
  dashboards: Dashboard[];
  activeId: string;
  datasets: SavedDataset[];
  /** 报表级筛选器：作用于所有页面（所有页面上的筛选器） */
  filters?: FilterCondition[];
  /** 视图 → 同步切片器：相同字段的切片器跨页联动 */
  syncSlicers?: boolean;
}
