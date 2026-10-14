import type { Workflow, WorkflowNode } from '../types.js';

export interface CompiledGraph {
  /** 拓扑排序后的节点执行顺序 */
  order: WorkflowNode[];
  /** nodeId -> (targetHandle -> 按连线顺序排列的上游来源：nodeId + 其输出端口) */
  inputNodes: Map<string, Record<string, Array<{ source: string; sourceHandle: string }>>>;
}

/** 计算 targetNodeId 的全部上游祖先节点 id（不含自身）。 */
export function ancestorNodeIds(workflow: Workflow, targetNodeId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  const seen = new Set<string>();
  const stack = [targetNodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const parent of incoming.get(current) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
}

/** 编译 DAG：校验连线、做拓扑排序并检测环。 */
export function compileGraph(workflow: Workflow): CompiledGraph {
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const inputNodes = new Map<
    string,
    Record<string, Array<{ source: string; sourceHandle: string }>>
  >();

  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
    inputNodes.set(node.id, {});
  }

  for (const edge of workflow.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      throw new Error(`连线引用了不存在的节点：${edge.source} → ${edge.target}`);
    }
    adjacency.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const handle = edge.targetHandle || 'in';
    const bucket = inputNodes.get(edge.target)!;
    const list = bucket[handle] ?? (bucket[handle] = []);
    // Union 允许单端口多输入（纵向拼接）；其余节点同一端口只允许一条连线。
    if (list.length > 0 && nodeById.get(edge.target)!.kind !== 'union') {
      throw new Error(`节点「${nodeById.get(edge.target)!.name}」的输入端口 ${handle} 有多条连线`);
    }
    list.push({ source: edge.source, sourceHandle: edge.sourceHandle || 'out' });
  }

  const queue: string[] = [];
  for (const [id, degree] of indegree.entries()) {
    if (degree === 0) queue.push(id);
  }

  const order: WorkflowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(nodeById.get(id)!);
    for (const next of adjacency.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== workflow.nodes.length) {
    throw new Error('工作流存在环路（循环依赖），无法执行');
  }

  return { order, inputNodes };
}
