import type {
  ColumnMeta,
  FileUploadResult,
  NodeKind,
  NodeResultEvent,
  PreviewData,
  ResourceBrowseResult,
  RunLogEvent,
  RunStatusEvent,
  SqlConnectionRef,
  SqlObjectRef,
  Workflow,
} from './types';

/** 发起运行后宿主返回的句柄。 */
export interface RunWorkflowResult {
  runId: string;
  /** 「缓存至此」成功受理后返回的缓存令牌。 */
  cacheToken?: string;
  /** 被冻结（已缓存）的节点 id，含边界节点及其全部上游。 */
  cachedNodeIds?: string[];
}

/** 发起运行的可选参数：冻结缓存 / 复用缓存。 */
export interface RunWorkflowOptions {
  /** 「缓存至此」：本次运行成功后冻结目标节点及其上游。 */
  freeze?: boolean;
  /** 复用已有缓存：缓存节点直接沿用结果。 */
  cacheToken?: string;
}

/** 运行事件订阅回调；宿主在 run 进入终态或连接关闭时调用 onDone 收尾。 */
export interface RunSubscriptionHandlers {
  onLog?: (event: RunLogEvent) => void;
  onNodeResult?: (event: NodeResultEvent) => void;
  onRunStatus?: (event: RunStatusEvent) => void;
  onError?: (error: unknown) => void;
  onDone?: () => void;
}

/**
 * 宿主注入的运行能力集合：发起运行、订阅运行事件、读取节点输出预览。
 * 三者需同时提供；缺一即视为宿主不支持画布内运行。
 */
export interface RunHost {
  runWorkflow: (
    workflow: Workflow,
    targetNodeId?: string,
    options?: RunWorkflowOptions,
  ) => Promise<RunWorkflowResult>;
  subscribeRun: (runId: string, handlers: RunSubscriptionHandlers) => () => void;
  loadPreview: (runId: string, nodeId: string, limit?: number) => Promise<PreviewData>;
  /** 解除服务端冻结缓存（「取消缓存」）。 */
  unpinCache?: (cacheToken: string) => Promise<void>;
}

/**
 * 设计器与宿主的唯一契约。
 * onSave：宿主决定写入平台（新建 POST / 编辑 PUT）。
 * 可选能力：宿主未提供时，对应控件不渲染、面板降级为手动输入。
 */
export interface DesignerAdapter {
  onSave(workflow: Workflow): Promise<void>;
  uploadFile?: (file: File) => Promise<FileUploadResult>;
  /** 浏览资源库目录（'' 为根目录）；文件条目带可直接写入配置的绝对路径。 */
  listResourceEntries?: (dir: string) => Promise<ResourceBrowseResult>;
  listSheets?: (path: string) => Promise<string[]>;
  /** 列出「连接」模块中可用的 SQL Server 连接。 */
  listSqlConnections?: () => Promise<SqlConnectionRef[]>;
  /** 列出指定连接自身数据库下的表/视图。 */
  listSqlObjectsByConnection?: (connectionId: string) => Promise<SqlObjectRef[]>;
  probeSchema?: (kind: NodeKind, config: Record<string, unknown>) => Promise<ColumnMeta[]>;
  /** 发起一次工作流运行。 */
  runWorkflow?: (
    workflow: Workflow,
    targetNodeId?: string,
    options?: RunWorkflowOptions,
  ) => Promise<RunWorkflowResult>;
  /** 订阅运行事件流；返回取消订阅函数。 */
  subscribeRun?: (runId: string, handlers: RunSubscriptionHandlers) => () => void;
  /** 读取指定节点运行结束后的输出预览。 */
  loadPreview?: (runId: string, nodeId: string, limit?: number) => Promise<PreviewData>;
  /** 解除服务端冻结缓存（「取消缓存」）。 */
  unpinCache?: (cacheToken: string) => Promise<void>;
}

export interface WorkflowDesignerProps {
  initialWorkflow: Workflow;
  adapter: DesignerAdapter;
  onExit?: () => void;
}
