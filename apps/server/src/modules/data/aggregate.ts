import sql from 'mssql';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';
import { toCell, type QueryCell, type QueryColumn, type QueryResult } from './query.js';

/**
 * 聚合下推：把「分组 + 聚合 + 筛选」交给数据库执行，浏览器只拿聚合结果。
 * 数据量超过行数上限（QueryResult.truncated）时，前端用这里的接口替代本地聚合。
 */

/** 支持下推的聚合函数（与前端 AggregateFn 一致，`none` 无法等价下推） */
export type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';

export const AGG_FNS: readonly AggFn[] = ['sum', 'count', 'avg', 'min', 'max'];

export const AGG_MAX_DIMENSIONS = 4;
export const AGG_MAX_MEASURES = 8;
export const AGG_MAX_FILTERS = 12;
export const AGG_DEFAULT_LIMIT = 5000;
export const AGG_MAX_LIMIT = 20000;

export interface AggMeasureSpec {
  field: string;
  agg: AggFn;
}

/** 行级筛选条件：值列表（标签值）/ 数值区间 / 日期区间，均为闭区间 */
export interface AggFilterSpec {
  field: string;
  /** 标签值（`(空)` 表示空值）；空数组视为不过滤 */
  values?: string[];
  min?: number;
  max?: number;
  /** 日期区间起点（epoch 毫秒） */
  from?: number;
  /** 日期区间终点（epoch 毫秒） */
  to?: number;
}

export interface AggregateSpec {
  /** 分组维度（0 个表示聚合为单行） */
  dimensions: string[];
  /** 系列字段：仅在单度量时生效，用于透视成多列 */
  series?: string;
  measures: AggMeasureSpec[];
  filters: AggFilterSpec[];
  limit?: number;
}

/** 聚合结果：列顺序固定为 d0… / s / m0…，由前端按 spec 位置解读 */
export interface AggregateResult extends QueryResult {
  /** 源数据总行数（本次聚合覆盖全量行；SQL Server 子查询无法廉价得知，可省略） */
  totalRows?: number;
}

/** 标识符引用、类型转换与行数限制的方言差异 */
export interface AggregateDialect {
  quote: (id: string) => string;
  /** 转数值（失败返回 NULL，不抛错） */
  asNumber: (expr: string) => string;
  /** 转字符串 */
  asText: (expr: string) => string;
  /** 转时间戳，用于与 epoch 毫秒比较 */
  asTimestamp: (expr: string) => string;
  /** epoch 毫秒 → SQL 时间戳字面量 */
  timestampLiteral: (ms: number) => string;
  /** 行数限制：SQL Server 用 SELECT TOP，DuckDB 用 LIMIT */
  limitPrefix: (cap: number) => string;
  limitSuffix: (cap: number) => string;
}

const duckQuote = (id: string): string => `"${id.replace(/"/g, '""')}"`;
const mssqlQuote = (id: string): string => `[${id.replace(/]/g, ']]')}]`;

/** epoch 毫秒 → `YYYY-MM-DD HH:mm:ss`（UTC，两端方言都能直接 CAST） */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export const DUCKDB_DIALECT: AggregateDialect = {
  quote: duckQuote,
  asNumber: (expr) => `TRY_CAST(${expr} AS DOUBLE)`,
  asText: (expr) => `CAST(${expr} AS VARCHAR)`,
  asTimestamp: (expr) => `CAST(${expr} AS TIMESTAMP)`,
  timestampLiteral: (ms) => `CAST('${utcStamp(ms)}' AS TIMESTAMP)`,
  limitPrefix: () => '',
  limitSuffix: (cap) => ` LIMIT ${cap}`,
};

export const MSSQL_DIALECT: AggregateDialect = {
  quote: mssqlQuote,
  asNumber: (expr) => `TRY_CAST(${expr} AS FLOAT)`,
  asText: (expr) => `CAST(${expr} AS NVARCHAR(4000))`,
  asTimestamp: (expr) => `CAST(${expr} AS DATETIME2)`,
  timestampLiteral: (ms) => `CAST('${utcStamp(ms)}' AS DATETIME2)`,
  limitPrefix: (cap) => `TOP (${cap}) `,
  limitSuffix: () => '',
};

/** 字符串字面量：单引号翻倍转义 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 维度/系列标签表达式：与前端 normalizeLabel 对齐（NULL 与空串统一为「(空)」） */
function labelExpr(field: string, d: AggregateDialect): string {
  return `COALESCE(NULLIF(${d.asText(d.quote(field))}, ''), '(空)')`;
}

function measureExpr(m: AggMeasureSpec, d: AggregateDialect): string {
  const col = d.quote(m.field);
  switch (m.agg) {
    case 'count':
      return 'COUNT(*)';
    case 'sum':
      // 前端 SUM 空集返回 0，SQL 返回 NULL，这里对齐
      return `COALESCE(SUM(${d.asNumber(col)}), 0)`;
    case 'avg':
      return `AVG(${d.asNumber(col)})`;
    case 'min':
      return `MIN(${d.asNumber(col)})`;
    default:
      return `MAX(${d.asNumber(col)})`;
  }
}

function filterExpr(f: AggFilterSpec, d: AggregateDialect): string | null {
  const clauses: string[] = [];
  if (f.values && f.values.length > 0) {
    clauses.push(`${labelExpr(f.field, d)} IN (${f.values.map(sqlLiteral).join(', ')})`);
  }
  const num = d.asNumber(d.quote(f.field));
  if (typeof f.min === 'number' && Number.isFinite(f.min)) clauses.push(`${num} >= ${f.min}`);
  if (typeof f.max === 'number' && Number.isFinite(f.max)) clauses.push(`${num} <= ${f.max}`);
  const ts = d.asTimestamp(d.quote(f.field));
  if (typeof f.from === 'number' && Number.isFinite(f.from)) {
    clauses.push(`${ts} >= ${d.timestampLiteral(f.from)}`);
  }
  if (typeof f.to === 'number' && Number.isFinite(f.to)) {
    clauses.push(`${ts} <= ${d.timestampLiteral(f.to)}`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

/**
 * 组装聚合 SQL：分组与聚合全部下推。
 * from 为已引用好的表名，或 `(子查询) AS 别名`。
 */
export function buildAggregateSql(
  spec: AggregateSpec,
  from: string,
  d: AggregateDialect,
  cap: number,
): string {
  const dims = spec.dimensions;
  const selects: string[] = dims.map((f, i) => `${labelExpr(f, d)} AS d${i}`);
  if (spec.series) selects.push(`${labelExpr(spec.series, d)} AS s`);
  spec.measures.forEach((m, i) => selects.push(`${measureExpr(m, d)} AS m${i}`));

  const wheres = spec.filters
    .map((f) => filterExpr(f, d))
    .filter((w): w is string => w !== null);

  // 分组表达式与 SELECT 保持一致，避免依赖各库「按别名分组」的差异
  const groupBy = [
    ...dims.map((f) => labelExpr(f, d)),
    ...(spec.series ? [labelExpr(spec.series, d)] : []),
  ];
  const orderBy = [
    ...dims.map((_, i) => `d${i}`),
    ...(spec.series ? ['s'] : []),
  ];

  const parts = [`SELECT ${d.limitPrefix(cap)}${selects.join(', ')} FROM ${from}`];
  if (wheres.length > 0) parts.push(`WHERE ${wheres.join(' AND ')}`);
  if (groupBy.length > 0) parts.push(`GROUP BY ${groupBy.join(', ')}`);
  if (orderBy.length > 0) parts.push(`ORDER BY ${orderBy.join(', ')}`);
  const suffix = d.limitSuffix(cap);
  if (suffix) parts.push(suffix.trim());
  return parts.join(' ');
}

/** 结果列：维度/系列按字符串处理，度量按数值处理 */
export function aggregateColumns(spec: AggregateSpec): QueryColumn[] {
  return [
    ...spec.dimensions.map((_, i) => ({ name: `d${i}`, type: 'string' as const })),
    ...(spec.series ? [{ name: 's', type: 'string' as const }] : []),
    ...spec.measures.map((_, i) => ({ name: `m${i}`, type: 'number' as const })),
  ];
}

export function aggregateLimit(spec: AggregateSpec): number {
  const raw = Number(spec.limit) || AGG_DEFAULT_LIMIT;
  return Math.min(Math.max(raw, 1), AGG_MAX_LIMIT);
}

/**
 * 校验聚合请求体。只做形状与白名单校验，字段是否存在交给调用方（需要列信息）。
 */
export function parseAggregateSpec(raw: unknown): { spec: AggregateSpec } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '请求体必须是对象' };
  const body = raw as Record<string, unknown>;

  const dimensions: string[] = [];
  if (body.dimensions !== undefined && body.dimensions !== null) {
    if (!Array.isArray(body.dimensions)) return { error: '维度必须是字符串数组' };
    for (const item of body.dimensions) {
      if (typeof item !== 'string' || !item.trim()) return { error: '维度包含非法字段' };
      dimensions.push(item.trim());
    }
    if (dimensions.length > AGG_MAX_DIMENSIONS) {
      return { error: `维度最多 ${AGG_MAX_DIMENSIONS} 个` };
    }
  }

  let series: string | undefined;
  if (body.series !== undefined && body.series !== null && body.series !== '') {
    if (typeof body.series !== 'string' || !body.series.trim()) return { error: '系列字段不合法' };
    series = body.series.trim();
  }

  if (!Array.isArray(body.measures) || body.measures.length === 0) {
    return { error: '至少需要一个度量字段' };
  }
  if (body.measures.length > AGG_MAX_MEASURES) {
    return { error: `度量字段最多 ${AGG_MAX_MEASURES} 个` };
  }
  const measures: AggMeasureSpec[] = [];
  for (const item of body.measures) {
    if (!item || typeof item !== 'object') return { error: '度量字段格式不合法' };
    const m = item as Record<string, unknown>;
    const field = typeof m.field === 'string' ? m.field.trim() : '';
    if (!field) return { error: '度量字段缺少列名' };
    if (typeof m.agg !== 'string' || !AGG_FNS.includes(m.agg as AggFn)) {
      return { error: `不支持的聚合方式：${String(m.agg)}` };
    }
    measures.push({ field, agg: m.agg as AggFn });
  }

  const rawFilters = body.filters === undefined || body.filters === null ? [] : body.filters;
  if (!Array.isArray(rawFilters)) return { error: '筛选条件必须是数组' };
  if (rawFilters.length > AGG_MAX_FILTERS) return { error: `筛选条件最多 ${AGG_MAX_FILTERS} 个` };
  const filters: AggFilterSpec[] = [];
  for (const item of rawFilters) {
    if (!item || typeof item !== 'object') return { error: '筛选条件格式不合法' };
    const f = item as Record<string, unknown>;
    const field = typeof f.field === 'string' ? f.field.trim() : '';
    if (!field) return { error: '筛选条件缺少列名' };
    const filter: AggFilterSpec = { field };
    if (f.values !== undefined && f.values !== null) {
      if (!Array.isArray(f.values) || f.values.some((x) => typeof x !== 'string')) {
        return { error: '筛选值必须是字符串数组' };
      }
      filter.values = (f.values as string[]).slice(0, 2000);
    }
    for (const key of ['min', 'max', 'from', 'to'] as const) {
      const value = f[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: `筛选条件 ${key} 必须是数字` };
      }
      filter[key] = value;
    }
    filters.push(filter);
  }

  const limit = typeof body.limit === 'number' ? body.limit : undefined;
  return { spec: { dimensions, ...(series ? { series } : {}), measures, filters, ...(limit !== undefined ? { limit } : {}) } };
}

/**
 * 去掉子查询里的顶层 ORDER BY：SQL Server 不允许派生子查询带 ORDER BY，
 * 带 OFFSET / FETCH 时无法安全剥离，原样返回（由数据库报错，前端降级为本地聚合）。
 */
export function stripTopLevelOrderBy(sqlText: string): string {
  const body = sqlText.trim().replace(/[\s;]+$/, '');
  const upper = body.toUpperCase();
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;
  let lastOrderBy = -1;
  let hasOffset = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inBracket) {
      if (ch === ']') inBracket = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '[') {
      inBracket = true;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    const boundary = i === 0 || /\s/.test(body[i - 1]);
    if (!boundary) continue;
    if (upper.startsWith('ORDER BY', i)) lastOrderBy = i;
    if (upper.startsWith('OFFSET', i)) hasOffset = true;
  }

  if (lastOrderBy < 0 || hasOffset) return body;
  return body.slice(0, lastOrderBy).trim();
}

/** 在 SQL Server 连接的查询结果上执行聚合（源为用户 SQL 或表名） */
export async function runAggregateOnSqlServer(
  conn: SqlServerConnection,
  sourceSql: string,
  spec: AggregateSpec,
): Promise<AggregateResult> {
  const cap = aggregateLimit(spec);
  const from = `(${stripTopLevelOrderBy(sourceSql)}) AS __agg_src`;
  // 多取一行用于判定分组是否被截断
  const sqlText = buildAggregateSql(spec, from, MSSQL_DIALECT, cap + 1);

  const pool = new sql.ConnectionPool(buildMssqlConfig(conn));
  try {
    await pool.connect();
    const result = await pool.request().query(sqlText);
    const recordset = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const aliases = aggregateColumns(spec).map((c) => c.name);
    const raw = recordset.map((r) => aliases.map((a) => toCell(r[a])));
    const truncated = raw.length > cap;
    return {
      columns: aggregateColumns(spec),
      rows: truncated ? raw.slice(0, cap) : raw,
      truncated,
    };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export interface SqlDistinctResult {
  values: QueryCell[];
  truncated: boolean;
}

/** 在 SQL Server 连接的查询结果上取某列去重值（按标签排序） */
export async function runDistinctOnSqlServer(
  conn: SqlServerConnection,
  sourceSql: string,
  field: string,
  limit: number,
): Promise<SqlDistinctResult> {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const from = `(${stripTopLevelOrderBy(sourceSql)}) AS __agg_src`;
  const sqlText =
    `SELECT DISTINCT TOP (${cap + 1}) ${labelExpr(field, MSSQL_DIALECT)} AS v FROM ${from} ORDER BY 1`;

  const pool = new sql.ConnectionPool(buildMssqlConfig(conn));
  try {
    await pool.connect();
    const result = await pool.request().query(sqlText);
    const recordset = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const values = recordset.map((r) => toCell(r.v));
    return { values: values.slice(0, cap), truncated: values.length > cap };
  } finally {
    await pool.close().catch(() => undefined);
  }
}
