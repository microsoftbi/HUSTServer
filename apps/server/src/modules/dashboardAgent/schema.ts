import { toLogicalType, type LogicalColumnType } from '../models/columnTypes.js';

/** 逻辑列类型：与前端 ColumnType 同名，便于提示词与校验统一口径 */
export type AgentColumnType = LogicalColumnType;

export interface AgentColumn {
  name: string;
  /** DuckDB 原始类型（如 DOUBLE / VARCHAR / TIMESTAMP），或用户配置改写后的类型 */
  type: string;
}

export interface AgentModel {
  name: string;
  rowCount: number;
  ownerId: string | null;
  columns: AgentColumn[];
}

export type SpecSlicerType =
  | 'list'
  | 'dropdown'
  | 'between'
  | 'before'
  | 'after'
  | 'relativeDate'
  | 'hierarchy';

export type SpecAgg = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'none';

export interface SpecSlicer {
  field: string;
  type?: SpecSlicerType;
}

export interface SpecKpi {
  title: string;
  field: string;
  agg: SpecAgg;
}

export interface SpecMeasure {
  field: string;
  agg: SpecAgg;
}

export interface SpecChart {
  type: string;
  title: string;
  dimension?: string;
  measures: SpecMeasure[];
}

/** 生成规格：只有语义结构，坐标与尺寸由前端本地排布 */
export interface DashboardSpec {
  name: string;
  slicers: SpecSlicer[];
  kpis: SpecKpi[];
  charts: SpecChart[];
}

/** 槽位：null 表示「用户还没说明」，空数组表示「用户明确不要」 */
export interface AgentSlots {
  model: string | null;
  slicers: SpecSlicer[] | null;
  kpis: SpecKpi[] | null;
  charts: SpecChart[] | null;
}

export const SLOT_KEYS = ['model', 'slicers', 'kpis', 'charts'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

/** 图表类型白名单（与前端 ChartType 中可承载数据的类型一致） */
export const CHART_WHITELIST = [
  'bar',
  'stackedBar',
  'horizontalBar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'treemap',
  'funnel',
  'table',
  'kpi',
  'matrix',
] as const;

/** 数量上限（超出截断并告警） */
export const MAX_SLICERS = 5;
export const MAX_KPIS = 4;
export const MAX_CHARTS = 6;

export const SLICER_TYPES: readonly SpecSlicerType[] = [
  'list',
  'dropdown',
  'between',
  'before',
  'after',
  'relativeDate',
  'hierarchy',
];

export const AGGS: readonly SpecAgg[] = ['sum', 'count', 'avg', 'min', 'max', 'none'];

export function logicalTypeOf(column: AgentColumn | undefined): AgentColumnType {
  return column ? toLogicalType(column.type) : 'string';
}

/** 字段名解析：先精确匹配，再忽略大小写与空格匹配（LLM 常见的大小写/空格偏差） */
export function resolveField(
  name: string,
  columns: AgentColumn[],
): AgentColumn | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const exact = columns.find((c) => c.name === wanted);
  if (exact) return exact;
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  return columns.find((c) => norm(c.name) === norm(wanted)) ?? null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 数值型聚合只能用于数值列；count 不受限制 */
function aggAllowed(agg: SpecAgg, type: AgentColumnType): boolean {
  if (agg === 'count' || agg === 'none') return true;
  return type === 'number';
}

function defaultSlicerType(type: AgentColumnType): SpecSlicerType {
  return type === 'date' ? 'between' : 'dropdown';
}

function slicerTypeAllowed(type: SpecSlicerType, columnType: AgentColumnType): boolean {
  const isRange = type === 'between' || type === 'before' || type === 'after' || type === 'relativeDate';
  if (isRange) return columnType === 'date' || columnType === 'number';
  return true;
}

/**
 * 校验并纠偏生成规格：
 * 字段必须存在、维度不能是数值、聚合与列类型匹配、图表类型白名单、数量上限、去重。
 * 非法对象直接剔除，并在 warnings 中说明原因。
 */
export function sanitizeSpec(
  raw: unknown,
  columns: AgentColumn[],
  fallbackName = 'AI 仪表板',
): { spec: DashboardSpec; warnings: string[] } {
  const warnings: string[] = [];
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const name = text(source.name) || fallbackName;

  // 切片器
  const slicers: SpecSlicer[] = [];
  const seenSlicer = new Set<string>();
  for (const item of asArray(source.slicers)) {
    if (slicers.length >= MAX_SLICERS) {
      warnings.push(`切片器最多 ${MAX_SLICERS} 个，多余的已忽略`);
      break;
    }
    if (!item || typeof item !== 'object') continue;
    const rawItem = item as Record<string, unknown>;
    const column = resolveField(text(rawItem.field), columns);
    if (!column) {
      const field = text(rawItem.field);
      if (field) warnings.push(`切片器字段「${field}」不存在，已忽略`);
      continue;
    }
    if (seenSlicer.has(column.name)) continue;
    seenSlicer.add(column.name);
    const columnType = logicalTypeOf(column);
    let type = SLICER_TYPES.includes(rawItem.type as SpecSlicerType)
      ? (rawItem.type as SpecSlicerType)
      : defaultSlicerType(columnType);
    if (!slicerTypeAllowed(type, columnType)) {
      warnings.push(`字段「${column.name}」不是日期/数值列，切片器已改为「下拉」`);
      type = 'dropdown';
    }
    slicers.push({ field: column.name, type });
  }

  // 数据卡片（KPI）
  const kpis: SpecKpi[] = [];
  const seenKpi = new Set<string>();
  for (const item of asArray(source.kpis)) {
    if (kpis.length >= MAX_KPIS) {
      warnings.push(`数据卡片最多 ${MAX_KPIS} 个，多余的已忽略`);
      break;
    }
    if (!item || typeof item !== 'object') continue;
    const rawItem = item as Record<string, unknown>;
    const column = resolveField(text(rawItem.field), columns);
    if (!column) {
      const field = text(rawItem.field);
      if (field) warnings.push(`数据卡片字段「${field}」不存在，已忽略`);
      continue;
    }
    if (seenKpi.has(column.name)) continue;
    const agg = AGGS.includes(rawItem.agg as SpecAgg) ? (rawItem.agg as SpecAgg) : 'sum';
    if (!aggAllowed(agg, logicalTypeOf(column))) {
      warnings.push(`字段「${column.name}」不是数值列，无法按 ${agg} 汇总，已忽略该卡片`);
      continue;
    }
    if (seenSlicer.has(column.name)) {
      warnings.push(`字段「${column.name}」已用作切片器，数据卡片已忽略`);
      continue;
    }
    seenKpi.add(column.name);
    kpis.push({ title: text(rawItem.title) || column.name, field: column.name, agg });
  }

  // 图表
  const charts: SpecChart[] = [];
  for (const item of asArray(source.charts)) {
    if (charts.length >= MAX_CHARTS) {
      warnings.push(`图表最多 ${MAX_CHARTS} 个，多余的已忽略`);
      break;
    }
    if (!item || typeof item !== 'object') continue;
    const rawItem = item as Record<string, unknown>;
    let type = text(rawItem.type);
    if (!(CHART_WHITELIST as readonly string[]).includes(type)) {
      if (type) warnings.push(`图表类型「${type}」不支持，已改为柱形图`);
      type = 'bar';
    }
    const measures: SpecMeasure[] = [];
    for (const rawMeasure of asArray(rawItem.measures)) {
      if (!rawMeasure || typeof rawMeasure !== 'object') continue;
      const m = rawMeasure as Record<string, unknown>;
      const column = resolveField(text(m.field), columns);
      if (!column) {
        const field = text(m.field);
        if (field) warnings.push(`图表「${text(rawItem.title) || type}」的度量字段「${field}」不存在，已忽略`);
        continue;
      }
      const agg = AGGS.includes(m.agg as SpecAgg) ? (m.agg as SpecAgg) : 'sum';
      if (!aggAllowed(agg, logicalTypeOf(column))) {
        warnings.push(`字段「${column.name}」不是数值列，无法按 ${agg} 汇总，已忽略该度量`);
        continue;
      }
      measures.push({ field: column.name, agg });
    }
    if (measures.length === 0) {
      warnings.push(`图表「${text(rawItem.title) || type}」没有可用的度量，已忽略`);
      continue;
    }

    let dimension: string | undefined;
    const rawDimension = resolveField(text(rawItem.dimension), columns);
    if (rawDimension) {
      const canNumericDimension = type === 'table' || type === 'matrix' || type === 'scatter';
      if (logicalTypeOf(rawDimension) === 'number' && !canNumericDimension) {
        warnings.push(`维度「${rawDimension.name}」是数值列，已忽略该维度`);
      } else {
        dimension = rawDimension.name;
      }
    }
    if (!dimension && type !== 'kpi' && type !== 'table') {
      warnings.push(`图表「${text(rawItem.title) || type}」缺少有效维度，已忽略该图表`);
      continue;
    }
    charts.push({
      type,
      title: text(rawItem.title) || dimension || type,
      ...(dimension ? { dimension } : {}),
      measures,
    });
  }

  return { spec: { name, slicers, kpis, charts }, warnings };
}

/** 从模型返回内容中提取 JSON 对象（容忍 ```json 代码块与前后说明文字） */
export function parseJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型返回内容不是合法的 JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error('模型返回内容不是合法的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的 JSON 不是对象');
  }
  return parsed as Record<string, unknown>;
}

/** 解析槽位输出：只接受 null 或数组；字段非法时交给 sanitizeSpec 剔除 */
export function parseSlotsOutput(raw: unknown): Partial<AgentSlots> {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<AgentSlots> = {};
  if (Array.isArray(source.slicers)) out.slicers = source.slicers as SpecSlicer[];
  if (Array.isArray(source.kpis)) out.kpis = source.kpis as SpecKpi[];
  if (Array.isArray(source.charts)) out.charts = source.charts as SpecChart[];
  return out;
}

/** 规整前端传入的槽位（防御式解析，避免脏数据进入提示词） */
export function normalizeSlots(raw: unknown): AgentSlots {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const slotArray = <T>(value: unknown): T[] | null => (Array.isArray(value) ? (value as T[]) : null);
  return {
    model: text(source.model) || null,
    slicers: slotArray<SpecSlicer>(source.slicers),
    kpis: slotArray<SpecKpi>(source.kpis),
    charts: slotArray<SpecChart>(source.charts),
  };
}

/** 槽位是否已全部确认 */
export function slotsReady(slots: AgentSlots): boolean {
  return (
    slots.model !== null &&
    slots.slicers !== null &&
    slots.kpis !== null &&
    slots.charts !== null
  );
}

/** 已确认槽位里视觉对象的总数（用于审计与预览展示） */
export function specWidgetCount(spec: DashboardSpec): number {
  return spec.slicers.length + spec.kpis.length + spec.charts.length;
}
