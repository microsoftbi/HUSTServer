import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api';
import type { AggregateFn, CellValue, ChartWidget, ColumnType, Dataset, QueryResult, TimeCompare } from '@bi/types';
import {
  effectiveDimensions,
  LEVEL_SEP,
  measureKey,
  normalizeLabel,
  type AggregatedData,
} from '@bi/lib/aggregate';
import {
  alignPreviousPeriod,
  baseAggKey,
  compileMeasure,
  evaluateMeasure,
  periodKeyOf,
  timeCompareLabel,
  type CompiledMeasure,
} from '@bi/lib/measure';
import { toEpoch } from '@bi/lib/slicer';
import type { CrossFilter, ValueFilter } from '@bi/lib/highlight';

/**
 * 聚合 / 去重值下推：数据量超过行数上限（`Dataset.truncated`）时，
 * 浏览器只拿到部分行，本地聚合会失真。这类数据集改用服务端接口在库内聚合，
 * 浏览器只接收聚合结果。非截断数据集继续走本地聚合，行为保持不变。
 */

/** 可下推的聚合函数（`none` 无法等价下推） */
export type PushAggFn = Exclude<AggregateFn, 'none'>;

export interface PushMeasure {
  field: string;
  agg: PushAggFn;
}

export interface PushFilter {
  field: string;
  values?: string[];
  min?: number;
  max?: number;
  from?: number;
  to?: number;
}

export interface PushSpec {
  dimensions: string[];
  series?: string;
  measures: PushMeasure[];
  filters: PushFilter[];
  /**
   * 视觉对象的输出度量：命名度量只下推它依赖的基础聚合，
   * 浏览器端再按表达式求值（与本地聚合口径一致）。
   */
  outputs?: PushOutput[];
}

export type PushOutput =
  | { kind: 'base'; key: string }
  | {
      kind: 'named';
      key: string;
      measureId: string;
      name: string;
      timeCompare?: TimeCompare;
    };

/** 服务端返回：列顺序固定为 d0… / s / m0… */
type PushAggResult = QueryResult;

interface PushDistinctResult {
  values: CellValue[];
  truncated: boolean;
}

const ALL_KEY = '__all__';
const MAX_MEASURES = 8;
/** 维度上限（与服务端 AGG_MAX_DIMENSIONS 保持一致），超出则退回本地聚合 */
const MAX_DIMENSIONS = 4;
const MAX_FILTERS = 12;
const MAX_FILTER_VALUES = 2000;
const CACHE_MAX = 60;

function datasetKey(dataset: Dataset): string {
  return `${dataset.id}|${dataset.fetchedAt ?? dataset.createdAt}`;
}

function canPush(dataset: Dataset | undefined): dataset is Dataset {
  if (!dataset || !dataset.truncated) return false;
  return dataset.def.kind === 'sql' || dataset.def.kind === 'model';
}

/**
 * 由视觉对象配置推导下推规格。
 * 无法等价下推时返回 null，调用方继续走本地聚合。
 */
export function buildAggSpec(
  widget: ChartWidget,
  dataset: Dataset,
  filters: ValueFilter[] | null | undefined,
  crossFilter: CrossFilter | null | undefined,
): PushSpec | null {
  if (!canPush(dataset)) return null;

  const known = new Set(dataset.columns.map((c) => c.name));
  const measures: PushMeasure[] = [];
  const outputs: PushOutput[] = [];
  const seen = new Set<string>();
  /** 记录一个基础聚合列（按 key 去重，多个命名度量可共用同一列） */
  const addBase = (agg: PushAggFn, field: string) => {
    const key = baseAggKey(agg, field);
    if (seen.has(key)) return;
    seen.add(key);
    measures.push({ field, agg });
  };

  for (const m of widget.encoding.measures) {
    if (m.measureId) {
      const def = dataset.measures?.[m.measureId];
      if (!def) return null;
      const compiled = compileMeasure(def);
      if (compiled.error || !compiled.ast) return null;
      if (compiled.fields.some((f) => !known.has(f))) return null;
      for (const b of compiled.bases) addBase(b.agg, b.field);
      outputs.push({
        kind: 'named',
        key: def.name,
        measureId: m.measureId,
        name: def.name,
        timeCompare: def.timeCompare,
      });
      continue;
    }
    if (!known.has(m.field)) continue;
    if (m.agg === 'none') return null;
    addBase(m.agg, m.field);
    outputs.push({ kind: 'base', key: measureKey(m) });
  }
  if (outputs.length === 0 || outputs.length > MAX_MEASURES) return null;
  if (measures.length === 0 || measures.length > MAX_MEASURES) return null;

  // 与本地聚合保持同一口径：X 轴多字段自动成层 / 钻取到某层 / 展开多层
  const dimensions = effectiveDimensions(widget.encoding, widget.drill).filter((d) =>
    known.has(d),
  );
  if (dimensions.length > MAX_DIMENSIONS) return null;
  // 系列仅在单度量时做透视（与本地聚合一致），多度量时忽略系列字段
  const series =
    measures.length === 1 &&
    outputs.length === 1 &&
    outputs[0].kind === 'base' &&
    widget.encoding.series &&
    known.has(widget.encoding.series)
      ? widget.encoding.series
      : undefined;

  const pushFilters: PushFilter[] = [];
  for (const f of filters ?? []) {
    if (!known.has(f.field)) continue;
    if (f.kind === 'values') {
      if (f.values.length === 0) continue;
      if (f.values.length > MAX_FILTER_VALUES) return null;
      pushFilters.push({ field: f.field, values: f.values });
    } else if (f.kind === 'range') {
      if (f.min === undefined && f.max === undefined) continue;
      pushFilters.push({ field: f.field, min: f.min, max: f.max });
    } else {
      if (f.from === undefined && f.to === undefined) continue;
      pushFilters.push({ field: f.field, from: f.from, to: f.to });
    }
  }
  if (crossFilter && crossFilter.values.length > 0 && known.has(crossFilter.field)) {
    if (crossFilter.values.length > MAX_FILTER_VALUES) return null;
    pushFilters.push({ field: crossFilter.field, values: crossFilter.values });
  }
  if (pushFilters.length > MAX_FILTERS) return null;

  return {
    dimensions,
    ...(series ? { series } : {}),
    measures,
    outputs,
    filters: pushFilters,
  };
}

async function pushAggregate(dataset: Dataset, spec: PushSpec): Promise<PushAggResult> {
  if (dataset.def.kind === 'model') {
    return api.post<PushAggResult>('/api/models/aggregate', {
      body: { name: dataset.def.modelName, ...spec },
    });
  }
  if (dataset.def.kind === 'sql') {
    return api.post<PushAggResult>('/api/data/aggregate', {
      body: { connectionId: dataset.def.connectionId, query: dataset.def.query, ...spec },
    });
  }
  throw new Error('该数据集来源不支持聚合下推');
}

function toText(v: CellValue): string {
  return v === null || v === undefined ? '(空)' : String(v);
}

function toNumberOrNull(v: CellValue): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 服务端行集 → 与本地 aggregate() 一致的图表数据 */
export function toAggregatedData(res: PushAggResult, spec: PushSpec): AggregatedData {
  const dimensionCount = spec.dimensions.length;
  /** 多级分组：与本地聚合一致，用「父 / 子」拼接类别标签 */
  const multi = dimensionCount > 1;
  const dimensionKey = multi
    ? spec.dimensions.join(LEVEL_SEP)
    : (spec.dimensions[0] ?? ALL_KEY);
  const measureKeys = spec.measures.map(measureKey);
  const seriesIndex = spec.series ? dimensionCount : -1;
  const measureOffset = dimensionCount + (spec.series ? 1 : 0);

  /** 维度列 → 各层原始值（无维度时为空） */
  const partsOf = (row: CellValue[]): string[] =>
    dimensionCount > 0 ? spec.dimensions.map((_, i) => toText(row[i])) : [];
  /** 分组标签：多级拼成「父 / 子」，与本地聚合的 labelOf 对齐 */
  const labelOf = (parts: string[]): string =>
    dimensionCount === 0 ? ALL_KEY : multi ? parts.join(LEVEL_SEP) : (parts[0] ?? ALL_KEY);

  const dimensionPaths: Record<string, string[]> = {};

  if (seriesIndex >= 0) {
    const series: string[] = [];
    const seenSeries = new Set<string>();
    const byDimension = new Map<string, Record<string, string | number | null>>();
    const order: string[] = [];
    for (const row of res.rows) {
      const parts = partsOf(row);
      // 无维度时所有行属于同一组，与本地聚合的 ALL_KEY 对齐
      const dimKey = labelOf(parts);
      if (multi) dimensionPaths[dimKey] = parts;
      const seriesValue = toText(row[seriesIndex]);
      if (!seenSeries.has(seriesValue)) {
        seenSeries.add(seriesValue);
        series.push(seriesValue);
      }
      let datum = byDimension.get(dimKey);
      if (!datum) {
        datum = { [dimensionKey]: dimKey };
        byDimension.set(dimKey, datum);
        order.push(dimKey);
      }
      datum[seriesValue] = toNumberOrNull(row[measureOffset]);
    }
    // 本地聚合对不存在的「维度 × 系列」组合补 SUM=0 / 其它=null，这里对齐
    const empty = spec.measures[0].agg === 'sum' ? 0 : null;
    for (const datum of byDimension.values()) {
      for (const sv of series) {
        if (!(sv in datum)) datum[sv] = empty;
      }
    }
    return {
      data: order.map((key) => byDimension.get(key)!),
      series,
      dimensionKey,
      measureKeys,
      ...(multi ? { dimensionPaths } : {}),
    };
  }

  const data = res.rows.map((row) => {
    const parts = partsOf(row);
    const dimKey = labelOf(parts);
    if (multi) dimensionPaths[dimKey] = parts;
    const datum: Record<string, string | number | null> = { [dimensionKey]: dimKey };
    spec.measures.forEach((_, i) => {
      datum[measureKeys[i]] = toNumberOrNull(row[measureOffset + i]);
    });
    return datum;
  });

  return {
    data,
    series: [],
    dimensionKey,
    measureKeys,
    ...(multi ? { dimensionPaths } : {}),
  };
}

/**
 * 服务端只回基础聚合列；命名度量（表达式）与时间对比在浏览器端补齐，
 * 与本地 `aggregate()` 使用同一套求值逻辑。
 */
export function finalizeOutputs(
  agg: AggregatedData,
  spec: PushSpec,
  dataset: Dataset,
): AggregatedData {
  const outputs = spec.outputs;
  if (!outputs) return agg;
  const measureKeys = outputs.map((o) => o.key);
  const named = outputs.filter(
    (o): o is Extract<PushOutput, { kind: 'named' }> => o.kind === 'named',
  );
  if (named.length === 0) return { ...agg, measureKeys };

  const compiled = new Map<string, CompiledMeasure>();
  for (const o of named) {
    const def = dataset.measures?.[o.measureId];
    if (def) compiled.set(def.name, compileMeasure(def));
  }

  const baseKeys = spec.measures.map((m) => baseAggKey(m.agg, m.field));
  const data = agg.data.map((row) => {
    const next = { ...row };
    const bases: Record<string, number | null> = {};
    for (const key of baseKeys) {
      const v = row[key];
      bases[key] = typeof v === 'number' ? v : null;
    }
    for (const o of named) next[o.name] = evaluateMeasure(o.name, compiled, bases);
    return next;
  });

  for (const o of named) {
    if (!o.timeCompare) continue;
    const kind = o.timeCompare.kind;
    const periods = data.map((row) => periodKeyOf(row[agg.dimensionKey], kind));
    const prev = alignPreviousPeriod(
      data.map((row, i) => ({
        label: String(row[agg.dimensionKey] ?? ''),
        period: periods[i],
        value: typeof row[o.name] === 'number' ? (row[o.name] as number) : null,
      })),
      kind,
    );
    const key = `${o.name}（${timeCompareLabel(kind)}）`;
    measureKeys.push(key);
    data.forEach((row, i) => {
      row[key] = prev[i];
    });
  }

  return { ...agg, data, measureKeys };
}

async function pushDistinct(dataset: Dataset, field: string, limit: number): Promise<CellValue[]> {
  if (dataset.def.kind === 'model') {
    const res = await api.post<PushDistinctResult>('/api/models/distinct', {
      body: { name: dataset.def.modelName, field, limit },
    });
    return res.values;
  }
  if (dataset.def.kind === 'sql') {
    const res = await api.post<PushDistinctResult>('/api/data/distinct', {
      body: { connectionId: dataset.def.connectionId, query: dataset.def.query, field, limit },
    });
    return res.values;
  }
  throw new Error('该数据集来源不支持去重值下推');
}

/** 与 distinctValues 相同的归一化与排序规则 */
export function sortDistinctValues(values: CellValue[], type: ColumnType, limit: number): string[] {
  const set = new Set<string>();
  for (const v of values) set.add(normalizeLabel(v));
  const out = [...set];
  if (type === 'number') {
    out.sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  } else if (type === 'date') {
    out.sort((a, b) => (toEpoch(a) ?? 0) - (toEpoch(b) ?? 0));
  } else {
    out.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  return out.slice(0, limit);
}

/* ---------------------------------------------------------------- 缓存 */

const resultCache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

function remember(key: string, value: unknown): void {
  if (resultCache.size >= CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, value);
}

/** 同一 key 只发一次请求；失败不缓存，下次渲染可重试 */
function loadCached<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  if (resultCache.has(key)) return Promise.resolve(resultCache.get(key) as T);
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;
  const pending = run()
    .then((value) => {
      remember(key, value);
      return value;
    })
    .catch(() => null as T | null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, pending as Promise<unknown>);
  return pending;
}

/* ---------------------------------------------------------------- hooks */

/** 取一个「按 key 缓存 + 变化即失效」的异步结果；key 变化期间返回 null */
function usePushedValue<T>(key: string | null, load: (() => Promise<T | null>) | null): T | null {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [entry, setEntry] = useState<{ key: string; value: T } | null>(null);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const run = loadRef.current;
    if (!run) return;
    void run().then((value) => {
      if (alive && value !== null) setEntry({ key, value });
    });
    return () => {
      alive = false;
    };
  }, [key]);

  if (!key || !entry || entry.key !== key) return null;
  return entry.value;
}

/**
 * 截断数据集的聚合结果；返回 null 表示应回退到本地聚合
 * （未截断、来源为文件、含 `none` 聚合或服务端失败）。
 */
export function usePushedAggregate(
  widget: ChartWidget,
  dataset: Dataset | undefined,
  filters: ValueFilter[] | null | undefined,
  crossFilter: CrossFilter | null | undefined,
): AggregatedData | null {
  const request = useMemo(() => {
    if (!dataset) return null;
    const spec = buildAggSpec(widget, dataset, filters, crossFilter);
    if (!spec) return null;
    const key = `agg|${datasetKey(dataset)}|${JSON.stringify(spec)}`;
    return {
      key,
      load: () =>
        loadCached<AggregatedData>(key, async () => {
          const res = await pushAggregate(dataset, spec);
          return finalizeOutputs(toAggregatedData(res, spec), spec, dataset);
        }),
    };
  }, [widget, dataset, filters, crossFilter]);

  return usePushedValue<AggregatedData>(request?.key ?? null, request?.load ?? null);
}

/** 截断数据集的字段去重值；返回 null 表示应回退到本地枚举 */
export function usePushedDistinct(
  dataset: Dataset | undefined,
  field: string | undefined,
  limit = 500,
): string[] | null {
  const request = useMemo(() => {
    if (!field || !canPush(dataset)) return null;
    const type = dataset.columns.find((c) => c.name === field)?.type ?? 'unknown';
    const key = `distinct|${datasetKey(dataset)}|${field}|${limit}`;
    return {
      key,
      load: () =>
        loadCached<string[]>(key, async () => {
          const values = await pushDistinct(dataset, field, limit);
          return sortDistinctValues(values, type, limit);
        }),
    };
  }, [dataset, field, limit]);

  return usePushedValue<string[]>(request?.key ?? null, request?.load ?? null);
}
