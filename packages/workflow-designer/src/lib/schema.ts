import type {
  AggregationConfig,
  AggregationFn,
  ColumnMeta,
  CrossTabConfig,
  FormulaConfig,
  JoinConfig,
  NodeKind,
  RunningTotalConfig,
  SelectConfig,
  TextToColumnsConfig,
  TransposeConfig,
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

/**
 * 输出列数取决于数据本身的节点：静态推导不可靠，
 * 有上次运行结果（`base` 中的 nodeColumns）时优先采用。
 */
const RUNTIME_SCHEMA_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'textToColumns',
  'crossTab',
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

    const runtime = RUNTIME_SCHEMA_KINDS.has(node.kind) ? base[nodeId] : undefined;
    const known = isInputKind(node.kind)
      ? base[nodeId]
      : runtime && runtime.length > 0
        ? runtime
        : undefined;
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
    case 'sample':
    case 'cleansing':
    /* 输出节点无下游，仅用于连线校验 */
    case 'dataModel':
      return upstream('in');

    /* Unique 的 U / D 两个锚点列结构一致，仅行不同 */
    case 'unique':
      return upstream('in');

    /* Running Total：覆盖项转为 DOUBLE，新增项追加 RunningTotal_<字段> */
    case 'runningTotal': {
      const cols = upstream('in').map((c) => ({ ...c }));
      const cfg = node.config as unknown as Partial<RunningTotalConfig>;
      for (const item of cfg.items ?? []) {
        const field = item?.field;
        if (!field) continue;
        if (item.replaceExisting) {
          const hit = cols.find((c) => c.name === field);
          if (hit) hit.type = 'DOUBLE';
        } else {
          cols.push({
            name: item.outputName?.trim() || `RunningTotal_${field}`,
            type: 'DOUBLE',
          });
        }
      }
      return cols;
    }

    /* Text to Columns：原字段被替换；拆列且未指定列数时列数只能运行后得知 */
    case 'textToColumns': {
      const cols = upstream('in');
      const cfg = node.config as unknown as Partial<TextToColumnsConfig>;
      const field = cfg.field?.trim();
      if (!field) return cols;
      if (cfg.mode === 'rows') {
        return cols.map((c) => (c.name === field ? { name: c.name, type: 'VARCHAR' } : c));
      }
      const out = cols.filter((c) => c.name !== field);
      const count = Math.trunc(Number(cfg.maxColumns ?? 0));
      if (count > 0) {
        const root = cfg.rootName?.trim() || field;
        for (let index = 1; index <= count; index += 1) {
          out.push({ name: `${root}${index}`, type: 'VARCHAR' });
        }
      }
      return out;
    }

    /* Cross Tab：分组字段固定，由表头值生成的新列需要运行后才可见 */
    case 'crossTab': {
      const cols = upstream('in');
      const cfg = node.config as unknown as Partial<CrossTabConfig>;
      const types = lookup(cols);
      return (cfg.groupBy ?? [])
        .filter((f) => f && f.length > 0)
        .map((f) => ({ name: f, type: types.get(f) ?? 'unknown' }));
    }

    /* Transpose：键字段 + Name + Value */
    case 'transpose': {
      const cols = upstream('in');
      const cfg = node.config as unknown as Partial<TransposeConfig>;
      const types = lookup(cols);
      const keys = (cfg.keyFields ?? [])
        .filter((f) => f && f.length > 0)
        .map((f) => ({ name: f, type: types.get(f) ?? 'unknown' }));
      const dataFields = (cfg.dataFields ?? []).filter((f) => f && f.length > 0);
      const dataTypes = new Set(dataFields.map((f) => types.get(f) ?? 'VARCHAR'));
      const valueType = dataTypes.size === 1 ? [...dataTypes][0] : 'VARCHAR';
      return [
        ...keys,
        { name: 'Name', type: 'VARCHAR' },
        { name: 'Value', type: valueType },
      ];
    }

    case 'formula': {
      const cols = upstream('in').map((c) => ({ ...c }));
      const cfg = node.config as unknown as Partial<FormulaConfig>;
      for (const item of cfg.formulas ?? []) {
        const name = item.field?.trim();
        if (!name) continue;
        const type = item.dataType ?? 'VARCHAR';
        const hit = cols.find((c) => c.name === name);
        if (hit) hit.type = type;
        else cols.push({ name, type });
      }
      return cols;
    }

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
