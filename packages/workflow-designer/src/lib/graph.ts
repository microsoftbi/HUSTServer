import type { WorkflowEdge } from '@/types';

/** 计算 targetNodeId 的全部上游祖先节点 id（不含自身）。 */
export function ancestorNodeIds(edges: WorkflowEdge[], targetNodeId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
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

/** 找到流入某节点指定端口的上游节点 id。 */
export function upstreamNodeId(
  edges: WorkflowEdge[],
  nodeId: string,
  handle = 'in',
): string | null {
  const edge = edges.find(
    (item) => item.target === nodeId && (item.targetHandle || 'in') === handle,
  );
  return edge ? edge.source : null;
}

/** 找到流入某节点指定端口的全部上游节点 id（按连线顺序）。 */
export function upstreamNodeIds(edges: WorkflowEdge[], nodeId: string, handle = 'in'): string[] {
  const ids: string[] = [];
  for (const edge of edges) {
    if (edge.target === nodeId && (edge.targetHandle || 'in') === handle) ids.push(edge.source);
  }
  return ids;
}
