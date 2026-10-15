/**
 * 前端类型契约，镜像 backend/src/types.ts（唯一事实来源）。
 * 修改节点配置结构时两端必须同步。
 */

export type NodeKind =
  | 'inputCsv'
  | 'inputExcel'
  | 'inputSqlServer'
  | 'select'
  | 'filter'
  | 'join'
  | 'union'
  | 'aggregation'
  | 'sort'
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

export interface InputSqlServerConfig {
  connection: SqlServerConnection;
  /** 记录所选表/视图，仅用于重新打开面板时回显。 */
  object?: SqlObjectRef;
  query: string;
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

export interface OutputCsvConfig {
  path: string;
  delimiter?: string;
  hasHeader?: boolean;
}

export interface OutputExcelConfig {
  path: string;
  sheet?: string;
}

export interface OutputSqlServerConfig {
  connection: SqlServerConnection;
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
  status: 'running' | 'success' | 'error';
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
