/** 与后端 parse.ts 的 InputRef/OutputRef 对齐（kind 在前端不做穷举，用 string）。 */
export interface InputRef {
  nodeId: string;
  name: string;
  kind: string;
  originalRef: string;
  binding: 'file' | 'connection';
}

export interface OutputRef {
  nodeId: string;
  name: string;
  kind: string;
  originalRef: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  owner_id: string;
  updated_at: number;
}

export interface WorkflowFileRow {
  id: string;
  workflow_id: string;
  node_id: string | null;
  original_ref: string;
  stored_name: string;
  size: number;
  created_at: number;
}

export type MappingTargetType = 'uploaded_file' | 'server_path' | 'connection' | 'output_dir' | 'resource';

export interface PathMappingRow {
  id: string;
  workflow_id: string;
  node_id: string;
  direction: 'input' | 'output';
  original_ref: string;
  target_type: MappingTargetType;
  target_ref: string | null;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  owner_id: string;
  workflow: unknown;
  files: WorkflowFileRow[];
  mappings: PathMappingRow[];
  updated_at: number;
}

/** 工作流内 SQL Server 节点的连接配置（后端返回时密码已掩码）。 */
export interface WorkflowConnectionNode {
  node_id: string;
  kind: string;
  name: string | null;
  config: Record<string, unknown> | null;
}

export interface RunSummary {
  id: string;
  workflow_id: string;
  schedule_id: string | null;
  trigger_type: string;
  status: string;
  engine_run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}
