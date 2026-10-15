import { create } from 'zustand';
import { NODE_META, getNodeMeta } from '@/lib/nodeMeta';
import { ancestorNodeIds } from '@/lib/graph';
import type { RunHost } from '@/adapters';
import type {
  AppSettings,
  ColumnMeta,
  NodeKind,
  NodeRunStatus,
  PreviewData,
  RunLogEvent,
  SqlServerConnection,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '@/types';

/** 运行日志最多保留的条数。 */
const MAX_LOGS = 2000;

/** 预览条目：按节点缓存加载态与数据。 */
export interface PreviewEntry {
  loading?: boolean;
  error?: string;
  data?: PreviewData;
}

interface NodeResultState {
  rowCount: number;
  durationMs: number;
  error?: string;
}

/** 应用设置浏览器本地持久化（随会话恢复）。 */
const SETTINGS_KEY = 'hustserver.designer.settings';
const MAX_PREVIEW_LIMIT = 10000;
const DEFAULT_SETTINGS: AppSettings = { previewRowLimit: MAX_PREVIEW_LIMIT };

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const limit = Number(parsed.previewRowLimit);
    if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_PREVIEW_LIMIT) {
      return { previewRowLimit: limit };
    }
  } catch {
    /* 读取失败时回退默认值 */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略持久化失败 */
  }
}

/** 当前运行的订阅取消函数（模块级，避免订阅泄漏）。 */
let unsubscribe: (() => void) | null = null;

/** 复用缓存失败的判定：宿主以 400 / code=CACHE_EXPIRED 表示服务端缓存已失效。 */
function isCacheExpired(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = error as { status?: number; code?: string };
  return cause.code === 'CACHE_EXPIRED' || cause.status === 400;
}

/** 宿主注入的结构探测能力：按节点类型与配置返回列结构。 */
export type SchemaProbe = (
  kind: NodeKind,
  config: Record<string, unknown>,
) => Promise<ColumnMeta[]>;

interface ProbePlan {
  /** 配置签名：签名未变化时跳过重复探测。 */
  signature: string;
  kind: NodeKind;
  config: Record<string, unknown>;
}

/** 依据输入节点配置构造探测请求；配置不完整（缺少必要字段）时返回 null。 */
function buildProbePlan(node: WorkflowNode): ProbePlan | null {
  const cfg = node.config;
  switch (node.kind) {
    case 'inputCsv': {
      const path = String(cfg.path ?? '');
      if (!path) return null;
      const delimiter = cfg.delimiter as string | undefined;
      const hasHeader = cfg.hasHeader !== false;
      const encoding = cfg.encoding as string | undefined;
      return {
        signature: JSON.stringify(['csv', path, delimiter ?? ',', hasHeader, encoding ?? 'utf-8']),
        kind: 'inputCsv',
        config: { path, delimiter, hasHeader, encoding },
      };
    }
    case 'inputExcel': {
      const path = String(cfg.path ?? '');
      if (!path) return null;
      const sheet = cfg.sheet as string | undefined;
      const hasHeader = cfg.hasHeader !== false;
      return {
        signature: JSON.stringify(['excel', path, sheet ?? '', hasHeader]),
        kind: 'inputExcel',
        config: { path, sheet, hasHeader },
      };
    }
    case 'inputSqlServer': {
      const connection = cfg.connection as SqlServerConnection | undefined;
      const query = String(cfg.query ?? '');
      if (!connection?.server || !connection.database || !connection.user || !query) return null;
      return {
        // 签名包含密码：平台留存的连接密码为掩码，用户重填真实密码后需重新探测。
        signature: JSON.stringify([
          'sqlserver',
          connection.server,
          connection.port ?? 1433,
          connection.database,
          connection.user,
          connection.password ?? '',
          query,
        ]),
        kind: 'inputSqlServer',
        config: { connection, query },
      };
    }
    default:
      return null;
  }
}

interface WorkflowState {
  /* 工作流本身 */
  workflowId: string | null;
  workflowName: string;
  /** 首次创建时间，随文件一起持久化。 */
  workflowCreatedAt: number | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  dirty: boolean;

  /* 各节点输出列（运行成功后回填，用于配置面板列下拉） */
  nodeColumns: Record<string, ColumnMeta[]>;

  /* 各输入节点探测得到的数据结构（配置完成后自动探测） */
  inputSchemas: Record<string, ColumnMeta[]>;
  /* 各输入节点最近一次探测所用的配置签名，未变化时跳过重复探测 */
  inputSchemaSignatures: Record<string, string>;
  /* 由宿主注入的结构探测能力；未提供时输入节点探测整体禁用。 */
  schemaProbe: SchemaProbe | null;

  /* 运行状态 */
  runId: string | null;
  runStatus: 'idle' | 'running' | 'success' | 'error';
  nodeStatus: Record<string, NodeRunStatus>;
  nodeResults: Record<string, NodeResultState>;
  logs: RunLogEvent[];
  /** 本次运行的节点范围（「运行至此」时为该节点及其上游，全量运行时为全部节点）。 */
  runScope: string[];
  /** 各节点预览缓存。 */
  previews: Record<string, PreviewEntry>;
  /** 由宿主注入的运行能力；未提供时运行相关 UI 整体禁用。 */
  runHost: RunHost | null;
  /** 应用设置（全局）。 */
  settings: AppSettings;

  /* 「缓存至此」冻结缓存 */
  /** 缓存令牌；非空表示存在服务端被冻结的缓存。 */
  cacheToken: string | null;
  /** 被冻结（已缓存）的节点 id，后续运行复用其成功结果。 */
  cachedNodeIds: string[];
  /** 缓存边界节点（「缓存至此」的目标节点）。 */
  cacheBoundaryNodeId: string | null;

  /* 运行与预览 */
  setRunHost: (host: RunHost | null) => void;
  /** 运行工作流；传入 targetNodeId 时仅运行该节点及其上游（「运行至此」）。 */
  run: (targetNodeId?: string, opts?: { freeze?: boolean }) => Promise<void>;
  /** 「缓存至此」：运行至该节点并冻结其及全部上游结果。 */
  cacheTo: (nodeId: string) => Promise<void>;
  /** 「取消缓存」：解除服务端冻结并清空本地缓存状态。 */
  clearCache: () => Promise<void>;
  loadPreview: (nodeId: string, limit?: number) => Promise<void>;
  fetchSchemas: (runId: string, nodeIds: string[]) => Promise<void>;
  clearLogs: () => void;
  clearRunState: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;

  /* 结构探测 */
  setSchemaProbe: (probe: SchemaProbe | null) => void;
  probeInputNode: (nodeId: string) => Promise<void>;
  probeAllInputs: () => Promise<void>;

  /* 画布操作 */
  addNode: (kind: NodeKind, position: { x: number; y: number }) => void;
  updateNodeName: (nodeId: string, name: string) => void;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  setNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  removeNode: (nodeId: string) => void;
  addEdge: (edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => void;
  removeEdge: (edgeId: string) => void;
  selectNode: (nodeId: string | null) => void;

  /* 工作流操作 */
  setWorkflowName: (name: string) => void;
  loadWorkflow: (wf: Workflow) => void;
  markSaved: () => void;
  snapshot: () => Workflow;
}

function nextNodeId(nodes: WorkflowNode[]): string {
  let max = 0;
  for (const node of nodes) {
    const match = /^n(\d+)$/.exec(node.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `n${max + 1}`;
}

function nextEdgeId(edges: WorkflowEdge[]): string {
  let max = 0;
  for (const edge of edges) {
    const match = /^e(\d+)$/.exec(edge.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `e${max + 1}`;
}

function buildAdjacency(edges: WorkflowEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const list = map.get(edge.source) ?? [];
    list.push(edge.target);
    map.set(edge.source, list);
  }
  return map;
}

/** 判断从 from 出发能否到达 to，用于阻止成环。 */
function reachable(edges: WorkflowEdge[], from: string, to: string): boolean {
  const adjacency = buildAdjacency(edges);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  workflowId: null,
  workflowName: '未命名工作流',
  workflowCreatedAt: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  dirty: false,

  nodeColumns: {},
  inputSchemas: {},
  inputSchemaSignatures: {},
  schemaProbe: null,

  runId: null,
  runStatus: 'idle',
  nodeStatus: {},
  nodeResults: {},
  logs: [],
  runScope: [],
  previews: {},
  runHost: null,
  settings: loadSettings(),

  cacheToken: null,
  cachedNodeIds: [],
  cacheBoundaryNodeId: null,

  setSchemaProbe: (probe) => set({ schemaProbe: probe }),

  probeInputNode: async (nodeId) => {
    const probe = get().schemaProbe;
    if (!probe) return;
    const node = get().nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const plan = buildProbePlan(node);
    if (!plan) return;
    if (get().inputSchemaSignatures[nodeId] === plan.signature) return;

    const { signature } = plan;
    let columns: ColumnMeta[] = [];
    try {
      columns = await probe(plan.kind, plan.config);
    } catch {
      columns = [];
    }
    set((state) => ({
      inputSchemas: { ...state.inputSchemas, [nodeId]: columns },
      inputSchemaSignatures: { ...state.inputSchemaSignatures, [nodeId]: signature },
    }));
  },

  probeAllInputs: async () => {
    await Promise.all(get().nodes.map((node) => get().probeInputNode(node.id)));
  },

  setRunHost: (host) => {
    if (!host) {
      unsubscribe?.();
      unsubscribe = null;
    }
    set({ runHost: host });
  },

  run: async (targetNodeId, opts) => {
    const { nodes, edges, runHost, cacheToken, cachedNodeIds } = get();
    if (nodes.length === 0 || !runHost) return;

    unsubscribe?.();
    unsubscribe = null;

    const freeze = opts?.freeze === true;
    // 复用缓存：全量运行且存在缓存令牌时，从缓存之后继续（缓存节点沿用成功结果）。
    const reuseToken = !freeze && !targetNodeId && cacheToken ? cacheToken : undefined;
    // 「运行至此」时执行范围为该节点及其全部上游祖先；全量运行时为 null。
    const scope = targetNodeId
      ? new Set([...ancestorNodeIds(edges, targetNodeId), targetNodeId])
      : null;

    let nodeStatus: Record<string, NodeRunStatus>;
    let nodeResults: Record<string, NodeResultState>;
    let previews: Record<string, PreviewEntry>;
    let nodeColumns: Record<string, ColumnMeta[]>;
    let runScopeIds: string[];

    if (reuseToken) {
      // 复用缓存：缓存节点保留既有成功结果，其余节点重置为待运行。
      nodeStatus = {};
      nodeResults = {};
      previews = {};
      nodeColumns = {};
      for (const node of nodes) nodeStatus[node.id] = 'pending';
      runScopeIds = nodes.map((node) => node.id);
      const current = get();
      for (const id of cachedNodeIds) {
        nodeStatus[id] = 'success';
        if (current.nodeResults[id]) nodeResults[id] = current.nodeResults[id];
        if (current.previews[id]) previews[id] = current.previews[id];
        if (current.nodeColumns[id]) nodeColumns[id] = current.nodeColumns[id];
      }
    } else if (scope) {
      // 局部运行：只把范围内置为 pending，范围外的节点状态与结果原样保留。
      nodeStatus = { ...get().nodeStatus };
      nodeResults = { ...get().nodeResults };
      previews = { ...get().previews };
      nodeColumns = { ...get().nodeColumns };
      runScopeIds = [...scope];
      for (const id of scope) {
        nodeStatus[id] = 'pending';
        delete nodeResults[id];
        delete previews[id];
        delete nodeColumns[id];
      }
    } else {
      // 全量运行：所有节点重置为 pending。
      nodeStatus = {};
      nodeResults = {};
      previews = {};
      nodeColumns = {};
      for (const node of nodes) nodeStatus[node.id] = 'pending';
      runScopeIds = nodes.map((node) => node.id);
    }

    set({
      runStatus: 'running',
      runId: null,
      nodeStatus,
      nodeResults,
      logs: [],
      previews,
      nodeColumns,
      runScope: runScopeIds,
    });

    const workflow = get().snapshot();
    try {
      const res = await runHost.runWorkflow(workflow, targetNodeId, {
        ...(freeze ? { freeze: true } : {}),
        ...(reuseToken ? { cacheToken: reuseToken } : {}),
      });
      set({ runId: res.runId });
      // 「缓存至此」：记录缓存令牌与被冻结的节点集合。
      if (freeze && res.cacheToken) {
        set({
          cacheToken: res.cacheToken,
          cachedNodeIds: res.cachedNodeIds ?? [],
          cacheBoundaryNodeId: targetNodeId ?? null,
        });
      }
      const runId = res.runId;
      unsubscribe = runHost.subscribeRun(runId, {
        onLog: (event) =>
          set((state) => ({ logs: [...state.logs, event].slice(-MAX_LOGS) })),
        onNodeResult: (event) =>
          set((state) => {
            const nextResults = { ...state.nodeResults };
            if (event.status !== 'running') {
              nextResults[event.nodeId] = {
                rowCount: event.rowCount,
                durationMs: event.durationMs,
                error: event.error,
              };
            }
            return {
              nodeStatus: { ...state.nodeStatus, [event.nodeId]: event.status },
              nodeResults: nextResults,
            };
          }),
        onRunStatus: (event) => {
          set({ runStatus: event.status });
          if (event.status === 'success') {
            const selected = get().selectedNodeId;
            if (selected) void get().loadPreview(selected);
            void get().fetchSchemas(runId, runScopeIds);
          }
        },
        onError: () => {
          /* EventSource 断开会由宿主自动重连；结束时由 onRunStatus 关闭 */
        },
      });
    } catch (error) {
      // 缓存已失效：清空缓存并自动回退为全量重跑一次。
      if (reuseToken && isCacheExpired(error)) {
        set({ cacheToken: null, cachedNodeIds: [], cacheBoundaryNodeId: null });
        await get().run();
        return;
      }
      set((state) => ({
        runStatus: 'error',
        logs: [
          ...state.logs,
          {
            runId: '',
            level: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
            ts: Date.now(),
          },
        ],
      }));
    }
  },

  cacheTo: async (nodeId) => {
    // 替换已有缓存：先解除旧缓存，再运行至该节点并冻结。
    if (get().cacheToken) await get().clearCache();
    await get().run(nodeId, { freeze: true });
  },

  clearCache: async () => {
    const { cacheToken, runHost } = get();
    if (cacheToken && runHost) {
      try {
        await runHost.unpinCache?.(cacheToken);
      } catch {
        /* 后端可能已重启或缓存已失效，忽略即可 */
      }
    }
    set({ cacheToken: null, cachedNodeIds: [], cacheBoundaryNodeId: null });
  },

  loadPreview: async (nodeId, limit) => {
    const { runId, runHost, settings } = get();
    if (!runId || !runHost) return;
    const effectiveLimit = limit ?? settings.previewRowLimit;
    set((state) => ({ previews: { ...state.previews, [nodeId]: { loading: true } } }));
    try {
      const data = await runHost.loadPreview(runId, nodeId, effectiveLimit);
      set((state) => ({ previews: { ...state.previews, [nodeId]: { data } } }));
    } catch (error) {
      set((state) => ({
        previews: {
          ...state.previews,
          [nodeId]: { error: error instanceof Error ? error.message : String(error) },
        },
      }));
    }
  },

  fetchSchemas: async (runId, nodeIds) => {
    const { runHost } = get();
    if (!runHost) return;
    const columns: Record<string, ColumnMeta[]> = {};
    await Promise.all(
      nodeIds.map(async (nodeId) => {
        if (get().nodeStatus[nodeId] !== 'success') return;
        try {
          const result = await runHost.loadPreview(runId, nodeId, 1);
          columns[nodeId] = result.columns;
        } catch {
          /* 该阶段无数据时忽略 */
        }
      }),
    );
    set({ nodeColumns: columns });
  },

  clearLogs: () => set({ logs: [] }),

  clearRunState: () => {
    unsubscribe?.();
    unsubscribe = null;
    // 一并解除服务端冻结，避免被钉住的会话长期驻留。
    const { cacheToken, runHost } = get();
    if (cacheToken && runHost) void runHost.unpinCache?.(cacheToken).catch(() => {});
    set({
      runId: null,
      runStatus: 'idle',
      nodeStatus: {},
      nodeResults: {},
      logs: [],
      previews: {},
      nodeColumns: {},
      runScope: [],
      cacheToken: null,
      cachedNodeIds: [],
      cacheBoundaryNodeId: null,
    });
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    saveSettings(settings);
    set({ settings, previews: {} });
    // 已选节点的预览按新行数立即重取
    const { selectedNodeId, runStatus, nodeStatus } = get();
    if (selectedNodeId && runStatus === 'success' && nodeStatus[selectedNodeId] === 'success') {
      void get().loadPreview(selectedNodeId);
    }
  },

  addNode: (kind, position) => {
    const meta = getNodeMeta(kind);
    const node: WorkflowNode = {
      id: nextNodeId(get().nodes),
      kind,
      name: meta.label,
      position,
      config: structuredClone(meta.defaultConfig),
    };
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      dirty: true,
    }));
  },

  updateNodeName: (nodeId, name) =>
    set((state) => ({
      nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, name } : node)),
      dirty: true,
    })),

  updateNodeConfig: (nodeId, config) =>
    set((state) => ({
      nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node)),
      dirty: true,
      previews: {},
    })),

  setNodePosition: (nodeId, position) =>
    set((state) => ({
      nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
      dirty: true,
    })),

  removeNode: (nodeId) =>
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== nodeId),
      edges: state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      dirty: true,
    })),

  addEdge: ({ source, target, sourceHandle, targetHandle }) => {
    const { nodes, edges } = get();
    if (source === target) return;
    const sourceNode = nodes.find((n) => n.id === source);
    const targetNode = nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) return;
    const sourceOutputs = NODE_META[sourceNode.kind].outputs;
    if (sourceOutputs.length === 0) return;
    const targetInputs = NODE_META[targetNode.kind].inputs;
    if (targetInputs.length === 0) return;

    const srcHandle = sourceHandle || sourceOutputs[0].id;
    if (!sourceOutputs.some((output) => output.id === srcHandle)) return;

    const handle = targetHandle || targetInputs[0].id;
    const validHandle = targetInputs.some((input) => input.id === handle);
    if (!validHandle) return;

    if (targetNode.kind === 'union') {
      // Union：单一输入端口允许多条连线（纵向拼接），但同一上游不重复连入。
      const duplicated = edges.some(
        (edge) =>
          edge.target === target &&
          (edge.targetHandle || 'in') === handle &&
          edge.source === source,
      );
      if (duplicated) return;
    } else {
      // 其余节点：同一目标端口只允许一条连线。
      const occupied = edges.some(
        (edge) => edge.target === target && (edge.targetHandle || 'in') === handle,
      );
      if (occupied) return;
    }

    // 阻止成环
    if (reachable(edges, target, source)) return;

    const edge: WorkflowEdge = {
      id: nextEdgeId(edges),
      source,
      target,
      sourceHandle: srcHandle,
      targetHandle: handle,
    };
    set({ edges: [...edges, edge], dirty: true });
  },

  removeEdge: (edgeId) =>
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== edgeId),
      dirty: true,
    })),

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  setWorkflowName: (name) => set({ workflowName: name, dirty: true }),

  loadWorkflow: (wf: Workflow) => {
    // 切换工作流时取消既有运行订阅并重置运行态，避免残留指向旧工作流。
    unsubscribe?.();
    unsubscribe = null;
    // 旧工作流的冻结缓存随之解除，避免会话与节点结果错配。
    const { cacheToken: oldCacheToken, runHost: oldRunHost } = get();
    if (oldCacheToken && oldRunHost) {
      void oldRunHost.unpinCache?.(oldCacheToken).catch(() => {});
    }
    set({
      workflowId: wf.id ?? '',
      workflowName: wf.name || '未命名工作流',
      workflowCreatedAt: wf.createdAt ?? '',
      nodes: wf.nodes,
      edges: wf.edges.map((edge) => ({
        ...edge,
        sourceHandle: edge.sourceHandle ?? 'out',
        targetHandle: edge.targetHandle ?? 'in',
      })),
      selectedNodeId: null,
      dirty: false,
      inputSchemas: {},
      inputSchemaSignatures: {},
      nodeColumns: {},
      runId: null,
      runStatus: 'idle',
      nodeStatus: {},
      nodeResults: {},
      logs: [],
      previews: {},
      runScope: [],
      cacheToken: null,
      cachedNodeIds: [],
      cacheBoundaryNodeId: null,
    });
  },

  markSaved: () => set({ dirty: false }),

  snapshot: () => ({
    id: get().workflowId ?? '',
    name: get().workflowName,
    nodes: get().nodes,
    edges: get().edges,
    createdAt: get().workflowCreatedAt ?? 0,
    updatedAt: Date.now(),
  }),
}));
