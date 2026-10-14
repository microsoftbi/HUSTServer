import type {
  AggregationConfig,
  AggregationFn,
  ColumnMeta,
  JoinConfig,
  NodeKind,
  SelectConfig,
  UnionConfig,
  UnionMatchMode,
  WorkflowEdge,
  WorkflowNode,
} from '@/types';
import { upstreamNodeId, upstreamNodeIds } from '@/lib/graph';

export type NodeColumns = Record<string, ColumnMeta[]>;

const INPUT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'inputCsv',
  'inputExcel',
  'inputSqlServer',
]);

export function isInputKind(kind: NodeKind): boolean {
  return INPUT_KINDS.has(kind);
}

function aggType(fn: AggregationFn, field: string, lookup: Map<string, string>): string {
  if (fn === 'count') return 'BIGINT';
  if (fn === 'sum' || fn === 'avg') return 'DOUBLE';
  return lookup.get(field) ?? 'unknown';
}

/**
 * 合并多路输入列（镜像后端 union.ts 的 mergeUnionColumns）。
 * - 按列名：取并集，保留首次出现顺序，同名只保留一次。
 * - 按位置：按索引对齐，列名取首个非空端口，重叠名以 `_2`、`_3` 递增去重。
 */
export function mergeUnionColumns(ports: ColumnMeta[][], matchMode: UnionMatchMode): ColumnMeta[] {
  if (matchMode === 'position') {
    const maxLen = ports.reduce((max, cols) => Math.max(max, cols.length), 0);
    const used = new Set<string>();
    const out: ColumnMeta[] = [];
    for (let i = 0; i < maxLen; i += 1) {
      let base = '';
      let type = 'unknown';
      for (const cols of ports) {
        if (i < cols.length) {
          base = cols[i].name;
          type = cols[i].type;
          break;
        }
      }
      let candidate = base;
      let k = 2;
      while (used.has(candidate)) {
        candidate = `${base}_${k}`;
        k += 1;
      }
      used.add(candidate);
      out.push({ name: candidate, type });
    }
    return out;
  }

  const seen = new Set<string>();
  const out: ColumnMeta[] = [];
  for (const cols of ports) {
    for (const col of cols) {
      if (seen.has(col.name)) continue;
      seen.add(col.name);
      out.push({ name: col.name, type: col.type });
    }
  }
  return out;
}

/**
 * 推导每个节点的输出列。
 * 输入节点列取自 `base`（探测结果 / 运行结果）；其余节点按配置从上游推导，
 * 推导规则镜像后端节点实现（select / aggregation / join），保证配置面板实时准确。
 */
export function deriveNodeColumns(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  base: NodeColumns,
): NodeColumns {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: NodeColumns = {};
  const visiting = new Set<string>();

  const resolve = (nodeId: string): ColumnMeta[] => {
    const cached = result[nodeId];
    if (cached) return cached;
    const node = byId.get(nodeId);
    if (!node || visiting.has(nodeId)) return [];
    visiting.add(nodeId);

    const known = isInputKind(node.kind) ? base[nodeId] : undefined;
    const columns = known ?? derive(node, edges, resolve);

    visiting.delete(nodeId);
    result[nodeId] = columns;
    return columns;
  };

  for (const node of nodes) resolve(node.id);
  return result;
}

function derive(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  resolve: (nodeId: string) => ColumnMeta[],
): ColumnMeta[] {
  const upstream = (handle: string): ColumnMeta[] => {
    const id = upstreamNodeId(edges, node.id, handle);
    return id ? resolve(id) : [];
  };
  const lookup = (cols: ColumnMeta[]): Map<string, string> =>
    new Map(cols.map((c) => [c.name, c.type]));

  switch (node.kind) {
    /* 输入节点结构来自探测结果，无上游可推导 */
    case 'inputCsv':
    case 'inputExcel':
    case 'inputSqlServer':
      return [];

    /* 行级转换：列结构原样透传 */
    case 'filter':
    case 'sort':
      return upstream('in');

    case 'select': {
      const cols = upstream('in');
      const cfg = node.config as unknown as Partial<SelectConfig>;
      const configured = (cfg.fields ?? [])
        .filter((f) => f && f.include !== false)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (configured.length === 0) return cols; // 空配置等价 SELECT *
      const types = lookup(cols);
      return configured.map((f) => ({
        name: f.alias && f.alias.length > 0 ? f.alias : f.source,
        type: types.get(f.source) ?? 'unknown',
      }));
    }

    case 'aggregation': {
      const cols = upstream('in');
      const cfg = node.config as unknown as Partial<AggregationConfig>;
      const types = lookup(cols);
      const groupBy = (cfg.groupBy ?? []).filter((f) => f && f.length > 0);
      const out: ColumnMeta[] = groupBy.map((f) => ({
        name: f,
        type: types.get(f) ?? 'unknown',
      }));
      for (const item of cfg.aggregations ?? []) {
        const fn = item.fn;
        if (!fn) continue;
        const field = item.field ?? '';
        const isCountAll = fn === 'count' && (field === '' || field === '*');
        const defaultAlias = isCountAll ? 'count_all' : `${fn}_${field}`;
        const name = item.alias && item.alias.length > 0 ? item.alias : defaultAlias;
        out.push({ name, type: aggType(fn, field, types) });
      }
      return out;
    }

    case 'join': {
      const left = upstream('left');
      const right = upstream('right');
      const cfg = node.config as unknown as Partial<JoinConfig>;
      const configured = cfg.selectFields ?? [];

      if (configured.length > 0) {
        const leftTypes = lookup(left);
        const rightTypes = lookup(right);
        return configured
          .filter((f) => f.include !== false)
          .map((f) => ({
            name: f.alias && f.alias.length > 0 ? f.alias : f.source,
            type: (f.side === 'right' ? rightTypes : leftTypes).get(f.source) ?? 'unknown',
          }));
      }

      /* 空配置：左表原样 + 右表重名加 right_ 前缀并按冲突递增（镜像后端） */
      const used = new Set<string>();
      const out: ColumnMeta[] = [];
      for (const c of left) {
        out.push({ name: c.name, type: c.type });
        used.add(c.name);
      }
      for (const c of right) {
        let alias = c.name;
        if (used.has(alias)) alias = `right_${alias}`;
        let candidate = alias;
        let i = 2;
        while (used.has(candidate)) {
          candidate = `${alias}_${i}`;
          i += 1;
        }
        used.add(candidate);
        out.push({ name: candidate, type: c.type });
      }
      return out;
    }

    case 'union': {
      const cfg = node.config as unknown as Partial<UnionConfig>;
      // 单一输入端口可连接多条连线，按连线顺序取全部上游列。
      const merged = mergeUnionColumns(
        upstreamNodeIds(edges, node.id, 'in').map((id) => resolve(id)),
        cfg.matchMode === 'position' ? 'position' : 'name',
      );
      const configured = (cfg.selectFields ?? []).filter((f) => f && f.include !== false);
      if (configured.length === 0) return merged;
      const types = lookup(merged);
      return configured.map((f) => ({
        name: f.alias && f.alias.length > 0 ? f.alias : f.source,
        type: types.get(f.source) ?? 'unknown',
      }));
    }

    default:
      return [];
  }
}
