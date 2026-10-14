import type { DuckDBConnection } from '@duckdb/node-api';
import type { WorkflowNode } from '../types.js';

export interface NodeLogLevel {
  level: 'info' | 'warn' | 'error' | 'success';
}

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
  log: (level: NodeLogLevel['level'], message: string) => void;
}

export interface NodeResult {
  rowCount: number;
  note?: string;
}

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeResult>;
