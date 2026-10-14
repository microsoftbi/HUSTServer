import type { NodeKind, Workflow, WorkflowEdge, WorkflowNode } from '@hustserver/engine';

export const NODE_KIND_WHITELIST: readonly NodeKind[] = [
  'inputCsv', 'inputExcel', 'inputSqlServer',
  'filter', 'select', 'join', 'union', 'sort', 'aggregate', 'derive', 'dedupe', 'limit',
  'outputCsv', 'outputExcel', 'outputSqlServer',
];

export const INPUT_NODE_KINDS: readonly NodeKind[] = ['inputCsv', 'inputExcel', 'inputSqlServer'];
export const OUTPUT_NODE_KINDS: readonly NodeKind[] = ['outputCsv', 'outputExcel', 'outputSqlServer'];

export interface InputRef {
  nodeId: string;
  name: string;
  kind: NodeKind;
  originalRef: string;
  binding: 'file' | 'connection';
}
export interface OutputRef {
  nodeId: string;
  name: string;
  kind: NodeKind;
  originalRef: string;
}

export class WorkflowParseError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

function assertNodeShape(n: unknown, index: number): asserts n is WorkflowNode {
  if (!n || typeof n !== 'object') throw new WorkflowParseError(`第 ${index} 个节点不是对象`);
  const node = n as Record<string, unknown>;
  for (const key of ['id', 'kind', 'name'] as const) {
    if (typeof node[key] !== 'string' || !node[key]) throw new WorkflowParseError(`节点缺少字段 ${key}`, `index=${index}`);
  }
  if (!NODE_KIND_WHITELIST.includes(node.kind as NodeKind)) {
    throw new WorkflowParseError(`未知节点类型 ${String(node.kind)}`, `nodeId=${String(node.id)}`);
  }
  if (!node.position || typeof node.position !== 'object') throw new WorkflowParseError(`节点缺少 position`, `nodeId=${String(node.id)}`);
  if (!node.config || typeof node.config !== 'object') throw new WorkflowParseError(`节点缺少 config`, `nodeId=${String(node.id)}`);
}

function assertEdgeShape(e: unknown, index: number): asserts e is WorkflowEdge {
  if (!e || typeof e !== 'object') throw new WorkflowParseError(`第 ${index} 条连线不是对象`);
  const edge = e as Record<string, unknown>;
  for (const key of ['id', 'source', 'target'] as const) {
    if (typeof edge[key] !== 'string' || !edge[key]) throw new WorkflowParseError(`连线缺少字段 ${key}`, `index=${index}`);
  }
}

function refOf(node: WorkflowNode): string {
  const cfg = node.config as Record<string, unknown>;
  if (typeof cfg.path === 'string') return cfg.path;
  if (node.kind === 'inputSqlServer' || node.kind === 'outputSqlServer') {
    const conn = cfg.connection as Record<string, unknown> | undefined;
    return conn && typeof conn.server === 'string' ? `${conn.server}:${String(conn.port ?? '')}/${String(conn.database ?? '')}` : '';
  }
  return '';
}

export function parseWorkflowPayload(text: string): { workflow: Workflow; inputs: InputRef[]; outputs: OutputRef[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorkflowParseError('工作流不是合法 JSON');
  }
  if (!raw || typeof raw !== 'object') throw new WorkflowParseError('工作流根节点必须是对象');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new WorkflowParseError('工作流缺少 name/nodes/edges');
  }

  const nodes = obj.nodes as unknown[];
  const edges = obj.edges as unknown[];
  const ids = new Set<string>();
  nodes.forEach((n, i) => {
    assertNodeShape(n, i);
    if (ids.has(n.id)) throw new WorkflowParseError(`节点 id 重复：${n.id}`);
    ids.add(n.id);
  });
  edges.forEach((e, i) => {
    assertEdgeShape(e, i);
    if (!ids.has(e.source) || !ids.has(e.target)) {
      throw new WorkflowParseError(`连线引用了不存在的节点`, `${e.source} -> ${e.target}`);
    }
  });

  const typedNodes = nodes as WorkflowNode[];
  const inputs: InputRef[] = typedNodes
    .filter((n) => INPUT_NODE_KINDS.includes(n.kind))
    .map((n) => ({
      nodeId: n.id, name: n.name, kind: n.kind, originalRef: refOf(n),
      binding: n.kind === 'inputSqlServer' ? 'connection' : 'file',
    }));
  const outputs: OutputRef[] = typedNodes
    .filter((n) => OUTPUT_NODE_KINDS.includes(n.kind))
    .map((n) => ({ nodeId: n.id, name: n.name, kind: n.kind, originalRef: refOf(n) }));

  const now = Date.now();
  const workflow: Workflow = {
    id: typeof obj.id === 'string' ? obj.id : `wf-${now}`,
    name: obj.name,
    nodes: typedNodes,
    edges: edges as WorkflowEdge[],
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : now,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : now,
  };
  return { workflow, inputs, outputs };
}
