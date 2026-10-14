import { create } from 'zustand';
import { NODE_META, getNodeMeta } from '@/lib/nodeMeta';
import type {
  ColumnMeta,
  NodeKind,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '@/types';

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
      nodeColumns: {},
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
