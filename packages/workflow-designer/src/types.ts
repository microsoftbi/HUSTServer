/**
 * 前端类型契约，镜像 backend/src/types.ts（唯一事实来源）。
 * 修改节点配置结构时两端必须同步。
 */

export type NodeKind =
  | 'inputCsv'
  | 'inputExcel'
  | 'inputSqlServer'
  | 'textInput'
  | 'select'
  | 'filter'
  | 'join'
  | 'findReplace'
  | 'union'
  | 'aggregation'
  | 'sort'
  | 'formula'
  | 'unique'
  | 'sample'
  | 'cleansing'
  | 'runningTotal'
  | 'textToColumns'
  | 'crossTab'
  | 'transpose'
  | 'dataModel'
  | 'outputCsv'
  | 'outputExcel'
  | 'outputSqlServer'
  | 'browser';

export interface Position {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  name: string;
  position: Position;
  config: Record<string, unknown>;
  /** 已禁用（bypass）：运行时跳过该节点，直接把输入透传到输出。 */
  disabled?: boolean;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

/* ----------------------------- 节点配置 Schema ----------------------------- */

export interface SqlServerConnection {
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export interface InputCsvConfig {
  path: string;
  delimiter?: string;
  hasHeader?: boolean;
  encoding?: 'utf-8' | 'gbk';
}

export interface InputExcelConfig {
  path: string;
  sheet?: string;
  hasHeader?: boolean;
}

/** SQL Server 对象类型：表或视图。 */
export type SqlObjectType = 'table' | 'view';

/** SQL Server 表/视图引用（用于输入节点记录所选对象）。 */
export interface SqlObjectRef {
  schema: string;
  name: string;
  type: SqlObjectType;
}

/** 「连接」模块中一个 SQL Server 连接的摘要，供设计器下拉选择。 */
export interface SqlConnectionRef {
  id: string;
  name: string;
  type: string;
  server?: string;
  database?: string;
}

export interface InputSqlServerConfig {
  /** 引用「连接」模块中的连接 id；新节点使用，运行时由服务端解析为真实连接。 */
  connectionId?: string;
  /** 内嵌连接信息（旧节点兼容；同时存在 connectionId 时以 connectionId 为准）。 */
  connection?: SqlServerConnection;
  /** 记录所选表/视图，仅用于重新打开面板时回显。 */
  object?: SqlObjectRef;
  query: string;
}

/** 手工输入字段的数据类型（对齐 Alteryx Text Input 的常用类型）。 */
export type TextInputFieldType = 'VARCHAR' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP';

export interface TextInputField {
  name: string;
  type: TextInputFieldType;
}

export interface TextInputConfig {
  fields: TextInputField[];
  rows: string[][];
}

/** Find Replace 的输出方式：替换原字段值 或 追加为新字段。 */
export type FindReplaceMode = 'replace' | 'append';

export interface FindReplaceConfig {
  field: string;
  findField?: string;
  replaceField?: string;
  mode: FindReplaceMode;
  newField?: string;
  matchCase?: boolean;
}

export interface SelectField {
  source: string;
  alias?: string;
  include: boolean;
  order: number;
}

export interface SelectConfig {
  fields: SelectField[];
}

export interface FilterConfig {
  expression: string;
}

export type JoinType = 'inner' | 'left' | 'right' | 'full';

export interface JoinSelectField {
  side: 'left' | 'right';
  source: string;
  alias?: string;
  /** 是否输出该字段；undefined 视为输出（兼容旧配置）。数组顺序即输出顺序。 */
  include?: boolean;
}

export interface JoinConfig {
  joinType: JoinType;
  leftKey: string;
  rightKey: string;
  selectFields?: JoinSelectField[];
}

/** Union 列对齐方式：按列名对齐 或 按位置对齐。 */
export type UnionMatchMode = 'name' | 'position';

export interface UnionSelectField {
  /** 合并后的输出列名（按列名/按位置对齐后的列）。 */
  source: string;
  alias?: string;
  /** 是否输出该字段；undefined 视为输出。数组顺序即输出顺序。 */
  include?: boolean;
}

export interface UnionConfig {
  /** 列对齐方式，默认按列名。 */
  matchMode: UnionMatchMode;
  /** 是否对合并结果去重（SELECT DISTINCT）。 */
  dedup: boolean;
  /** 输出字段配置；为空时等价输出全部合并列。 */
  selectFields?: UnionSelectField[];
}

export type AggregationFn = 'sum' | 'count' | 'max' | 'min' | 'avg';

export interface AggregationItem {
  field: string;
  fn: AggregationFn;
  alias?: string;
}

export interface AggregationConfig {
  groupBy: string[];
  aggregations: AggregationItem[];
}

export interface SortItem {
  field: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface SortConfig {
  sorts: SortItem[];
}

/** Formula 输出列的数据类型（对齐 Alteryx 的常用类型，映射到 DuckDB）。 */
export type FormulaDataType = 'VARCHAR' | 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP';

export interface FormulaItem {
  /** 输出列名：与现有列同名即覆盖该列，否则追加新列。 */
  field: string;
  dataType: FormulaDataType;
  /** 字符串字段的宽度；DuckDB 不强制截断，仅作声明。 */
  size?: number;
  expression: string;
}

export interface FormulaConfig {
  /** 按数组顺序依次计算，后面的表达式可以引用前面新建的列。 */
  formulas: FormulaItem[];
}

export interface UniqueConfig {
  /** 判断唯一值的字段；U 输出每组首行，D 输出每组其余行。 */
  fields: string[];
}

/** 抽样方式：前 N 行 / 后 N 行 / 跳过前 N 行 / 每 N 行首行 / 随机 1/N / 前 N%。 */
export type SampleMode = 'first' | 'last' | 'skip' | 'every' | 'random' | 'percent';

export interface SampleConfig {
  mode: SampleMode;
  n: number;
  /** 按列分组后每组各取 N 行；为空表示全表。 */
  groupBy?: string[];
}

/** null 判定方式：any=含 null 即算，all=整行/整列都为 null 才算。 */
export type NullRemovalMode = 'any' | 'all';

export interface CleansingConfig {
  /** 参与字符清理的字段；为空表示全部字段。 */
  fields: string[];
  removeNullRows: boolean;
  nullRowMode: NullRemovalMode;
  removeNullColumns: boolean;
  nullColumnMode: NullRemovalMode;
  /** 字符串 null 替换为空白值。 */
  replaceNullString: boolean;
  /** 数值 null 替换为 0。 */
  replaceNullNumber: boolean;
  /** 去除前导和尾随空格。 */
  trimWhitespace: boolean;
  /** 制表符 / 换行符 / 重复空格压缩为单个空格。 */
  reduceWhitespace: boolean;
  /** 去除所有空格。 */
  removeAllWhitespace: boolean;
  removeLetters: boolean;
  removeNumbers: boolean;
  removePunctuation: boolean;
  caseMode: 'none' | 'upper' | 'lower' | 'title';
}

/** Running Total 的单个累计项。 */
export interface RunningTotalItem {
  /** 参与累计的数值字段。 */
  field: string;
  /** 新列名；为空时用 RunningTotal_<字段>。 */
  outputName?: string;
  /** 覆盖原列（保持列位置），而不是追加新列。 */
  replaceExisting?: boolean;
}

export interface RunningTotalConfig {
  /** 分组字段：每组内重新开始累计（对应 Alteryx 的 Group By）。 */
  groupBy: string[];
  items: RunningTotalItem[];
}

/** Text to Columns 输出形态：拆成多列 或 拆成多行。 */
export type TextToColumnsMode = 'columns' | 'rows';

export interface TextToColumnsConfig {
  /** 要拆分的字段。 */
  field: string;
  /** 分隔符，支持多字符。 */
  delimiter: string;
  mode: TextToColumnsMode;
  /** 拆分后的根名称，默认与原字段同名，新列为 <根名称>1、<根名称>2… */
  rootName?: string;
  /** 忽略空分段（Alteryx 的 Skip empty fields）。 */
  skipEmpty?: boolean;
  /** 拆分为列时的列数；0 / 空表示自动按最大分段数。 */
  maxColumns?: number;
}

/** Cross Tab 的取值合并方式（对应 Alteryx 的 Aggregation Method）。 */
export type CrossTabMethod = 'first' | 'last' | 'sum' | 'count' | 'min' | 'max' | 'concat';

export interface CrossTabConfig {
  /** 分组字段，输出时每个组合一行；为空则汇成一行。 */
  groupBy: string[];
  /** 表头字段：其取值成为新列名。 */
  headerField: string;
  /** 值字段：填入交叉单元格。 */
  valueField: string;
  method: CrossTabMethod;
  /** 新列名前缀（可选）。 */
  prefix?: string;
}

export interface TransposeConfig {
  /** 保持不变的键字段，输出时每行重复。 */
  keyFields: string[];
  /** 转成行的数据字段。 */
  dataFields: string[];
}

export interface OutputCsvConfig {
  path: string;
  delimiter?: string;
  hasHeader?: boolean;
}

/** Data Model 输出的同名处理方式。 */
export type DataModelDuplicateMode = 'overwrite' | 'error';

export interface DataModelOutputConfig {
  /** 目标数据模型名（同时是模型库中的表名）。 */
  modelName: string;
  /** 同名模型已存在时：覆盖，或报错终止本次运行。 */
  onDuplicate: DataModelDuplicateMode;
}

export interface OutputExcelConfig {
  path: string;
  sheet?: string;
}

export interface OutputSqlServerConfig {
  /** 引用「连接」模块中的连接 id；新节点使用，运行时由服务端解析为真实连接。 */
  connectionId?: string;
  /** 内嵌连接信息（旧节点兼容；同时存在 connectionId 时以 connectionId 为准）。 */
  connection?: SqlServerConnection;
  table: string;
  mode: 'append' | 'overwrite';
  createTable?: boolean;
}

/* ----------------------------- 杂项类型 ----------------------------- */

export type NodeRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface ColumnMeta {
  name: string;
  type: string;
}

/* ----------------------------- 运行与预览类型 ----------------------------- */

export interface RunLogEvent {
  runId: string;
  nodeId?: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  ts: number;
}

export interface NodeResultEvent {
  runId: string;
  type: 'node-result';
  nodeId: string;
  status: NodeRunStatus;
  rowCount: number;
  durationMs: number;
  error?: string;
}

export interface RunStatusEvent {
  runId: string;
  type: 'run-status';
  status: 'running' | 'success' | 'error' | 'canceled';
  message?: string;
}

/** 单个节点运行结束后的输出数据（来自宿主预览端点）。 */
export interface PreviewData {
  nodeId: string;
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
}

/** 应用设置（全局，所有组件共用）。 */
export interface AppSettings {
  /** 数据预览时每个节点取回的行数上限。 */
  previewRowLimit: number;
}

export interface FileUploadResult {
  path: string;
  name: string;
  size: number;
  sheets?: string[];
}

/** 资源库目录中的一个条目。 */
export interface ResourceEntryRef {
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  /** 仅文件：绝对路径，可直接写入节点 config.path。 */
  path?: string;
}

/** 资源库目录浏览结果；dir 为相对资源库根的路径（'' 表示根目录）。 */
export interface ResourceBrowseResult {
  dir: string;
  entries: ResourceEntryRef[];
}
