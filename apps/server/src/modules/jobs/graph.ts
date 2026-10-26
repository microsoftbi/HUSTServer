import type { JobNodeMode } from './repo.js';

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphNodeLike {
  key: string;
  mode: JobNodeMode;
}

/** 由边构造「父 → 子」邻接表。 */
export function buildChildren(edges: GraphEdge[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const e of edges) {
    const list = children.get(e.source);
    if (list) list.push(e.target);
    else children.set(e.source, [e.target]);
  }
  return children;
}

/** BFS 求 key 的全部可达后代（不含自身）。 */
export function descendantsOf(key: string, edges: GraphEdge[]): string[] {
  const children = buildChildren(edges);
  const seen = new Set<string>();
  const queue = [...(children.get(key) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(children.get(cur) ?? []));
  }
  return [...seen];
}

/** 返回一条环路径（首尾相同），无环时返回 null。 */
export function findCycle(keys: string[], edges: GraphEdge[]): string[] | null {
  const children = buildChildren(edges);
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 访问中 / 2 已完成
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    state.set(key, 1);
    stack.push(key);
    for (const child of children.get(key) ?? []) {
      const st = state.get(child) ?? 0;
      if (st === 1) return [...stack.slice(stack.indexOf(child)), child];
      if (st === 0) {
        const found = visit(child);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };

  for (const key of keys) {
    if ((state.get(key) ?? 0) === 0) {
      const found = visit(key);
      if (found) return found;
    }
  }
  return null;
}

/** 有环时抛错，文案包含完整环路，便于前端直接提示。 */
export function assertAcyclic(keys: string[], edges: GraphEdge[]): void {
  const cycle = findCycle(keys, edges);
  if (cycle) throw new Error(`存在循环依赖：${cycle.join(' → ')}`);
}

/** Kahn 拓扑排序；keys 的入参顺序作为同层稳定顺序。调用方需先保证无环。 */
export function topoOrder(keys: string[], edges: GraphEdge[]): string[] {
  const order = new Map(keys.map((k, i) => [k, i]));
  const children = buildChildren(edges);
  const indegree = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const e of edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const ready = keys.filter((k) => (indegree.get(k) ?? 0) === 0);
  const out: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const key = ready.shift()!;
    out.push(key);
    for (const child of children.get(key) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return out;
}

/**
 * 计算被禁用的节点集合：`mode=disable` 的节点及其全部可达后代。
 * 只依赖自身的 mode，不做级联写库，因此上游改回 run 后下游自动恢复。
 */
export function disabledKeys(nodes: GraphNodeLike[], edges: GraphEdge[]): Set<string> {
  const disabled = new Set<string>();
  for (const node of nodes) {
    if (node.mode !== 'disable') continue;
    disabled.add(node.key);
    for (const key of descendantsOf(node.key, edges)) disabled.add(key);
  }
  return disabled;
}

/** 有效可执行节点：未被禁用且 mode=run。 */
export function executableCount(nodes: GraphNodeLike[], edges: GraphEdge[]): number {
  const disabled = disabledKeys(nodes, edges);
  return nodes.filter((n) => !disabled.has(n.key) && n.mode === 'run').length;
}
