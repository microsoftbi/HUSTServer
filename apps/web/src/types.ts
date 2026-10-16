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

/** Job 编排相关类型（与 jobs/repo.ts、jobs/routes.ts 对齐）。 */
export type JobStepType = 'workflow' | 'sql' | 'load_model';
export type JobOnFailure = 'abort' | 'continue';
export type LoadModelSource = 'file' | 'sqlserver';

export type JobStepConfig =
  | { workflowId: string }
  | { connectionId: string; sql: string }
  | { source: 'file'; modelName: string; resourcePath: string; format?: 'csv' | 'excel' }
  | { source: 'sqlserver'; modelName: string; connectionId: string; object?: string; query?: string };

export interface JobStep {
  id: string;
  job_id: string;
  seq: number;
  type: JobStepType;
  name: string;
  config: JobStepConfig;
  on_failure: JobOnFailure;
  created_at: number;
}

export interface JobScheduleState {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron' | null;
  cronExpr: string | null;
  timezone: string;
}

export interface JobSummary {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  enabled: number;
  freq_type: string | null;
  cron_expr: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
  stepCount: number;
  nextRunAt: number | null;
  lastRun: { id: string; status: string; created_at: number } | null;
}

export interface JobDetail {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  enabled: number;
  freq_type: string | null;
  cron_expr: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
  nextRunAt: number | null;
  steps: JobStep[];
  schedule: JobScheduleState;
}

export interface JobRunSummary {
  id: string;
  job_id: string;
  trigger_type: 'manual' | 'schedule';
  triggered_by: string | null;
  status: 'queued' | 'running' | 'success' | 'error';
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

export interface JobStepRunSummary {
  id: string;
  job_run_id: string;
  step_id: string | null;
  seq: number;
  type: string;
  name: string;
  config: string;
  on_failure: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  output: string | null;
  created_at: number;
}
