import type { JobEdge, JobNode } from '../../../types.js';

/** 从 start 出发沿边能否到达 target（用于连线前的环检测）。 */
function reaches(edges: JobEdge[], start: string, target: string): boolean {
  if (start === target) return true;
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.source);
    if (list) list.push(edge.target);
    else next.set(edge.source, [edge.target]);
  }
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const child of next.get(key) ?? []) {
      if (child === target) return true;
      queue.push(child);
    }
  }
  return false;
}

/** 新增 source → target 是否会形成环（自环 / 已有反向通路）。 */
export function wouldCreateCycle(
  edges: JobEdge[],
  source: string,
  target: string,
): { ok: true } | { ok: false; reason: string } {
  if (source === target) return { ok: false, reason: '不能把节点连到自己' };
  if (edges.some((e) => e.source === source && e.target === target)) {
    return { ok: false, reason: '这两个节点已经连过了' };
  }
  if (reaches(edges, target, source)) return { ok: false, reason: '这条连线会形成循环依赖' };
  return { ok: true };
}

/** 节点的全部后代（不含自身）。 */
export function descendantsOf(edges: JobEdge[], keys: string[]): Set<string> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.source);
    if (list) list.push(edge.target);
    else next.set(edge.source, [edge.target]);
  }
  const result = new Set<string>();
  const queue = [...keys];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const child of next.get(key) ?? []) {
      if (result.has(child)) continue;
      result.add(child);
      queue.push(child);
    }
  }
  return result;
}

/** 被禁用的节点集合：mode=disable 自身 + 其全部后代（与后端语义一致）。 */
export function disabledKeys(nodes: JobNode[], edges: JobEdge[]): Set<string> {
  const disabled = nodes.filter((n) => n.mode === 'disable').map((n) => n.key);
  return new Set([...disabled, ...descendantsOf(edges, disabled)]);
}

/** 最长前置链层级：rank = 所有前驱 rank 的最大值 + 1（按 key 排序保证稳定）。 */
export function nodeRanks(nodes: JobNode[], edges: JobEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.key, []);
  for (const edge of edges) incoming.get(edge.target)?.push(edge.source);

  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (key: string): number => {
    const cached = ranks.get(key);
    if (cached !== undefined) return cached;
    // 防御：画布上理论上无环，脏数据时按 0 处理
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parents = incoming.get(key) ?? [];
    const rank = parents.length === 0 ? 0 : Math.max(...parents.map((p) => rankOf(p) + 1));
    visiting.delete(key);
    ranks.set(key, rank);
    return rank;
  };
  for (const node of nodes) rankOf(node.key);
  return ranks;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

/** 分层自动布局：x 按层级、同层按坐标纵向居中排列。 */
export function autoLayout(nodes: JobNode[], edges: JobEdge[]): Map<string, LayoutPosition> {
  const ranks = nodeRanks(nodes, edges);
  const columns = new Map<number, JobNode[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.key) ?? 0;
    const list = columns.get(rank);
    if (list) list.push(node);
    else columns.set(rank, [node]);
  }
  const result = new Map<string, LayoutPosition>();
  const rowGap = 140;
  for (const [rank, list] of columns) {
    const sorted = [...list].sort((a, b) => a.y - b.y || a.key.localeCompare(b.key));
    const offset = ((sorted.length - 1) * rowGap) / 2;
    sorted.forEach((node, index) => {
      result.set(node.key, { x: rank * 280, y: index * rowGap - offset });
    });
  }
  return result;
}

/** 所有坐标都为 0（首次打开）时自动整理布局。 */
export function needsAutoLayout(nodes: JobNode[]): boolean {
  return nodes.length > 1 && nodes.every((n) => n.x === 0 && n.y === 0);
}
