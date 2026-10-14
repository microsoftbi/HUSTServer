import type { ColumnMeta, FileUploadResult, NodeKind, SqlObjectRef, SqlServerConnection, Workflow } from './types';

/**
 * 设计器与宿主的唯一契约。
 * onSave：宿主决定写入平台（新建 POST / 编辑 PUT）。
 * 可选能力：平台一阶段均不提供，面板自动降级为手动输入。
 */
export interface DesignerAdapter {
  onSave(workflow: Workflow): Promise<void>;
  uploadFile?: (file: File) => Promise<FileUploadResult>;
  listSheets?: (path: string) => Promise<string[]>;
  listSqlDatabases?: (connection: SqlServerConnection) => Promise<string[]>;
  listSqlObjects?: (connection: SqlServerConnection) => Promise<SqlObjectRef[]>;
  probeSchema?: (kind: NodeKind, config: Record<string, unknown>) => Promise<ColumnMeta[]>;
}

export interface WorkflowDesignerProps {
  initialWorkflow: Workflow;
  adapter: DesignerAdapter;
  onExit?: () => void;
}
