/**
 * 前后端共享的工作流 DAG 类型契约与节点配置定义。
 * 该文件是前端 `frontend/src/types.ts` 的唯一事实来源，两端保持同步。
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

export const NODE_KINDS: NodeKind[] = [
  'inputCsv',
  'inputExcel',
  'inputSqlServer',
  'select',
  'filter',
  'join',
  'union',
  'aggregation',
  'sort',
  'outputCsv',
  'outputExcel',
  'outputSqlServer',
  'browser',
];

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
  /** SQL 布尔表达式，例如: amount > 100 AND status = 'PAID' */
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

/* ----------------------------- 运行与预览类型 ----------------------------- */

export type NodeRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

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

export type SseEvent = RunLogEvent | NodeResultEvent | RunStatusEvent;

export interface ColumnMeta {
  name: string;
  type: string;
}

export interface PreviewResult {
  nodeId: string;
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/* ----------------------------- 应用设置 ----------------------------- */

export interface AppSettings {
  /** 数据预览时每个组件从缓存中取回的行数上限，所有组件共用。 */
  previewRowLimit: number;
}
