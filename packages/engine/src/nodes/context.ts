import type { DuckDBConnection } from '@duckdb/node-api';
import type { WorkflowNode } from '../types.js';

export interface NodeLogLevel {
  level: 'info' | 'warn' | 'error' | 'success';
}

/** 把一段 Parquet 写入系统数据模型的请求（由宿主注入，引擎不直接访问模型库）。 */
export interface ModelWriteRequest {
  /** 目标数据模型名，同时也是模型库中的表名。 */
  modelName: string;
  /** 同名模型已存在时的处理方式：覆盖 / 报错终止。 */
  onDuplicate: 'overwrite' | 'error';
  /** 已写出的 Parquet 临时文件绝对路径，调用返回后由引擎负责删除。 */
  parquetPath: string;
}

export interface ModelWriteResult {
  rowCount: number;
  /** 是否覆盖了已存在的同名模型。 */
  replaced: boolean;
}

export type ModelWriteHook = (request: ModelWriteRequest) => Promise<ModelWriteResult>;

export interface NodeContext {
  node: WorkflowNode;
  /** targetHandle -> 上游表名（一般节点为 'in'，Join 为 'left' / 'right'）；单端口多输入时取第一条。 */
  inputs: Record<string, string>;
  /** targetHandle -> 按连线顺序排列的上游表名（Union 等单端口多输入节点会用到全部元素）。 */
  inputLists: Record<string, string[]>;
  /** 按连线顺序排列的全部上游表名 */
  inputList: string[];
  connection: DuckDBConnection;
  /** 本节点主输出（'out'）的表名 */
  outputTable: string;
  /** 按输出端口取表名：handle 为空 / 'out' 即主输出，其余端口（如 'f'）映射到独立表。 */
  outputTableFor: (handle?: string | null) => string;
  /** 写出数据模型的能力；仅宿主（服务端）注入了 sink 时可用。 */
  writeModel?: ModelWriteHook;
  log: (level: NodeLogLevel['level'], message: string) => void;
}

export interface NodeResult {
  rowCount: number;
  note?: string;
}

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeResult>;
