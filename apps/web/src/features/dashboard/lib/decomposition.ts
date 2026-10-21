// 分解树（Decomposition Tree）的纯函数库：按展开字段递归拆分节点、AI 拆分启发式与列布局。
// 均为无副作用函数，便于单测；渲染与交互由 DecompositionTree 负责。

import type {
  AggregateFn,
  CellValue,
  ChartWidget,
  Dataset,
  DecompositionConfig,
  DecompositionSplit,
  Measure,
} from "@bi/types";
import { applyAgg, normalizeLabel } from "./aggregate";
import { CHART_COLORS } from "./chart";

/** 展开方式中的 AI 拆分（与 Power BI 的「高值 / 低值」对应） */
export const AI_HIGH: DecompositionSplit = "__ai_high__";
export const AI_LOW: DecompositionSplit = "__ai_low__";

/** 根节点的路径 key（子节点 key 由条件编码而成） */
export const ROOT_KEY = "__root__";

/** 最大展开深度，避免配置异常时无限递归 */
const MAX_DEPTH = 10;

export interface DecompCondition {
  field: string;
  value: string;
}

export interface DecompNode {
  /** 路径 key：由祖先条件编码，作为展开状态的存储键 */
  key: string;
  /** 节点标签（根节点为度量名） */
  name: string;
  value: number;
  depth: number;
  /** 产生该节点的拆分字段（根节点为空） */
  field?: string;
  children: DecompNode[];
}

/** 单次分组的中间结果（保留行以便继续向下拆分） */
interface RowGroup {
  name: string;
  value: number;
  rows: CellValue[][];
}

/** Power BI 分解树的默认外观 */
export function defaultDecomposition(): DecompositionConfig {
  return {
    baseColor: CHART_COLORS[0],
    showBars: true,
    showValues: true,
    showLevelHeaders: true,
    showConnectors: true,
    aiSplits: true,
    labelColor: "#1e293b",
    fontSize: 11,
    maxBars: 6,
    expansions: {},
  };
}

/** 读取分解树配置：旧仪表板没有该字段时回落到默认值 */
export function decompositionOf(widget: ChartWidget): DecompositionConfig {
  return { ...defaultDecomposition(), ...(widget.decomposition ?? {}) };
}

/** 节点路径 key：字段与值都做 URI 编码，避免值中的分隔符冲突 */
export function nodeKey(conditions: DecompCondition[]): string {
  if (conditions.length === 0) return ROOT_KEY;
  return conditions
    .map((c) => `${encodeURIComponent(c.field)}=${encodeURIComponent(c.value)}`)
    .join("|");
}

/** 按字段分组合计（标签归一化规则与交叉筛选一致） */
function groupRows(
  rows: CellValue[][],
  fieldIdx: number,
  measureIdx: number,
  agg: AggregateFn,
): RowGroup[] {
  const buckets = new Map<string, CellValue[][]>();
  for (const row of rows) {
    const name = normalizeLabel(row[fieldIdx]);
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = [];
      buckets.set(name, bucket);
    }
    bucket.push(row);
  }

  const groups: RowGroup[] = [];
  for (const [name, cells] of buckets) {
    const value = applyAgg(
      cells.map((r) => r[measureIdx]),
      agg,
    );
    groups.push({ name, value: value ?? 0, rows: cells });
  }
  return groups;
}

/**
 * AI 拆分启发式（本地计算，不依赖外部模型）：
 * - 高值：选择「头部类别占比最高」的字段，即最能解释高值的维度；
 * - 低值：选择「最低类别相对均值偏离最大」的字段，即最能解释低值的维度。
 * 已用于祖先节点的字段优先级更低，避免在同一路径上重复拆分同一维度。
 */
export function aiSplitField(
  dataset: Dataset,
  rows: CellValue[][],
  measure: Measure,
  fields: string[],
  mode: DecompositionSplit,
  exclude: string[] = [],
): string | null {
  const measureIdx = dataset.columns.findIndex((c) => c.name === measure.field);
  if (measureIdx < 0) return null;

  function scoreOf(field: string): number | null {
    if (field === measure.field) return null;
    const idx = dataset.columns.findIndex((c) => c.name === field);
    if (idx < 0) return null;
    const groups = groupRows(rows, idx, measureIdx, measure.agg)
      .filter((g) => g.value > 0)
      .sort((a, b) => b.value - a.value);
    if (groups.length < 2) return null;
    const total = groups.reduce((sum, g) => sum + g.value, 0);
    if (total <= 0) return null;
    if (mode === AI_HIGH) {
      return Math.min(1, Math.max(0, groups[0].value / total));
    }
    const avg = total / groups.length;
    const min = groups[groups.length - 1].value;
    return Math.min(1, Math.max(0, (avg - min) / avg));
  }

  const preferred = fields.filter((f) => !exclude.includes(f));
  const candidates = preferred.length > 0 ? preferred : fields;
  let best: string | null = null;
  let bestScore = -1;
  for (const field of candidates) {
    const score = scoreOf(field);
    if (score !== null && score > bestScore) {
      best = field;
      bestScore = score;
    }
  }
  return best;
}

/** 解析一次展开请求，返回实际用于拆分的字段（AI 拆分时动态选字段） */
function resolveField(
  dataset: Dataset,
  rows: CellValue[][],
  measure: Measure,
  explainBy: string[],
  requested: string | undefined,
  aiEnabled: boolean,
  used: string[],
): string | null {
  if (!requested) return null;
  if (requested === AI_HIGH || requested === AI_LOW) {
    if (!aiEnabled) return null;
    return aiSplitField(dataset, rows, measure, explainBy, requested, used);
  }
  return explainBy.includes(requested) ? requested : null;
}

/**
 * 构建分解树：从合计节点出发，按 `expansions` 中记录的字段逐层拆分。
 * - 每层按值降序，只保留前 `maxBars` 个节点（与 Power BI 一致）；
 * - 子节点值来自与父节点相同的行集合，保证父子金额一致；
 * - 空值与缺失字段自动跳过，不会抛错。
 */
export function buildDecomposition(
  dataset: Dataset,
  measure: Measure,
  explainBy: string[],
  expansions: Record<string, string>,
  options: { maxBars?: number; aiSplits?: boolean } = {},
): DecompNode | null {
  const measureIdx = dataset.columns.findIndex((c) => c.name === measure.field);
  if (measureIdx < 0) return null;

  const maxBars = Math.max(1, options.maxBars ?? 6);
  const aiEnabled = options.aiSplits ?? true;
  const usableFields = explainBy.filter((f) =>
    dataset.columns.some((c) => c.name === f),
  );

  const root: DecompNode = {
    key: ROOT_KEY,
    name: measure.field,
    value:
      applyAgg(
        dataset.rows.map((r) => r[measureIdx]),
        measure.agg,
      ) ?? 0,
    depth: 0,
    children: [],
  };

  function expand(node: DecompNode, rows: CellValue[][], conditions: DecompCondition[]) {
    if (node.depth >= MAX_DEPTH) return;
    const field = resolveField(
      dataset,
      rows,
      measure,
      usableFields,
      expansions[node.key],
      aiEnabled,
      conditions.map((c) => c.field),
    );
    if (!field) return;
    const fieldIdx = dataset.columns.findIndex((c) => c.name === field);
    if (fieldIdx < 0) return;

    node.children = groupRows(rows, fieldIdx, measureIdx, measure.agg)
      .filter((g) => g.value !== 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, maxBars)
      .map((group) => {
        const childConditions = [...conditions, { field, value: group.name }];
        const child: DecompNode = {
          key: nodeKey(childConditions),
          name: group.name,
          value: group.value,
          depth: node.depth + 1,
          field,
          children: [],
        };
        expand(child, group.rows, childConditions);
        return child;
      });
  }

  expand(root, dataset.rows, []);
  return root;
}

/** 收集树中每一列（层级）的节点，便于纵向对齐与测试 */
export function collectColumns(root: DecompNode): DecompNode[][] {
  const columns: DecompNode[][] = [];
  const walk = (node: DecompNode) => {
    (columns[node.depth] ??= []).push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return columns;
}

export interface DecompLayoutOptions {
  columnWidth: number;
  columnGap: number;
  nodeHeight: number;
  rowGap: number;
  headerHeight: number;
  /** 根列标题（通常为度量名） */
  rootHeader: string;
}

export interface DecompBox {
  node: DecompNode;
  /** 列序号，根列为 0 */
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
  parentKey?: string;
}

export interface DecompLayout {
  boxes: DecompBox[];
  /** 每列顶部标题：根列为度量名，其余为拆分字段名 */
  headers: string[];
  width: number;
  height: number;
  columns: number;
}

/**
 * 列式树布局（与 Power BI 分解树一致）：父节点垂直居中于其子节点区域，
 * 各列宽度一致，节点之间的连接线由渲染层根据 parentKey 绘制。
 */
export function layoutDecomposition(
  root: DecompNode,
  options: DecompLayoutOptions,
): DecompLayout {
  const { columnWidth, columnGap, nodeHeight, rowGap, headerHeight } = options;
  const boxes: DecompBox[] = [];
  const spanCache = new Map<string, number>();

  /** 子树占用的垂直高度（叶子为单节点高度） */
  function spanOf(node: DecompNode): number {
    const cached = spanCache.get(node.key);
    if (cached !== undefined) return cached;
    let span = nodeHeight;
    if (node.children.length > 0) {
      const childrenSpan =
        node.children.reduce((sum, child) => sum + spanOf(child), 0) +
        rowGap * (node.children.length - 1);
      span = Math.max(nodeHeight, childrenSpan);
    }
    spanCache.set(node.key, span);
    return span;
  }

  let maxColumn = 0;

  function place(
    node: DecompNode,
    column: number,
    top: number,
    parentKey?: string,
  ): DecompBox {
    const span = spanOf(node);
    maxColumn = Math.max(maxColumn, column);

    if (node.children.length === 0) {
      const box: DecompBox = {
        node,
        column,
        x: column * (columnWidth + columnGap),
        y: top + (span - nodeHeight) / 2,
        w: columnWidth,
        h: nodeHeight,
        parentKey,
      };
      boxes.push(box);
      return box;
    }

    const childrenSpan =
      node.children.reduce((sum, child) => sum + spanOf(child), 0) +
      rowGap * (node.children.length - 1);
    let childTop = top + (span - childrenSpan) / 2;
    const children: DecompBox[] = [];
    for (const child of node.children) {
      children.push(place(child, column + 1, childTop, node.key));
      childTop += spanOf(child) + rowGap;
    }

    // 父节点对齐到第一个与最后一个子节点的中心（与 Power BI 的树形对齐一致）
    const first = children[0];
    const last = children[children.length - 1];
    const center =
      (first.y + nodeHeight / 2 + last.y + nodeHeight / 2) / 2;
    const box: DecompBox = {
      node,
      column,
      x: column * (columnWidth + columnGap),
      y: center - nodeHeight / 2,
      w: columnWidth,
      h: nodeHeight,
      parentKey,
    };
    boxes.push(box);
    return box;
  }

  place(root, 0, headerHeight);

  const headers: string[] = [];
  for (const box of boxes) {
    if (box.column > 0 && box.node.field && !headers[box.column]) {
      headers[box.column] = box.node.field;
    }
  }
  headers[0] = options.rootHeader;
  for (let i = 0; i <= maxColumn; i += 1) headers[i] ??= "";

  return {
    boxes,
    headers,
    width:
      (maxColumn + 1) * columnWidth + maxColumn * columnGap,
    height: headerHeight + spanOf(root),
    columns: maxColumn + 1,
  };
}

/** 节点占根节点的比例（用于数据条长度与提示中的占比） */
export function valueRatio(value: number, rootValue: number): number {
  if (rootValue <= 0 || value <= 0) return 0;
  return Math.min(1, value / rootValue);
}
