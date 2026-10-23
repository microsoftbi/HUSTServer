import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  closeSession,
  countRows,
  describeTable,
  dropTable,
  loadCsvInto,
  loadExcelInto,
  loadSqlServerInto,
  materializeRows,
  openModelDb,
  promoteStagingTable,
  quoteIdent,
  type ColumnInfo,
  type DuckSession,
  type SqlServerConnection,
} from '@hustserver/engine';
import { nanoid } from 'nanoid';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import type { QueryCell, QueryColumn, QueryResult } from '../data/query.js';
import { resolveResourcePath } from '../resources/paths.js';
import { createSemaphore } from '../runs/queue.js';
import {
  coerceCell,
  mergeColumnTypes,
  parseColumnTypeConfig,
  toQueryColumnType,
  type LogicalColumnType,
} from './columnTypes.js';
import { dataModelsRepo, modelColumnConfigsRepo, type ModelSourceKind } from './repo.js';

/** DuckDB 连接类型从 engine 公开面推导，避免 server 直接依赖 @duckdb/node-api。 */
type DuckConnection = DuckSession['connection'];

/** 模型名即 DuckDB 表名：字母/下划线开头，仅含字母数字下划线，最长 64。 */
export const MODEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 取数上限（与 modules/data/query.ts 保持一致，避免依赖其模块私有常量）。 */
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

export type LoadModelConfig =
  | {
      source: 'file';
      modelName: string;
      resourcePath: string;
      format?: 'csv' | 'excel';
      delimiter?: string;
      hasHeader?: boolean;
      encoding?: 'utf-8' | 'gbk';
      sheet?: string;
    }
  | {
      source: 'sqlserver';
      modelName: string;
      connectionId: string;
      object?: string;
      query?: string;
    };

/** 来自内存行数据的模型（如审计日志） */
export interface LoadRowsConfig {
  modelName: string;
  rows: Array<Record<string, unknown>>;
  /** 行数据列名（空行集时用于建表） */
  columns: string[];
  sourceKind: ModelSourceKind;
  sourceRef: Record<string, unknown>;
}

/** 从 Parquet 文件导入模型（Data Model 输出节点使用）。 */
export interface ImportParquetConfig {
  modelName: string;
  parquetPath: string;
  /** 额外的来源信息，写入 data_models.source_ref。 */
  sourceRef?: Record<string, unknown>;
}

export interface LoadResult {
  rowCount: number;
  columns: ColumnInfo[];
}

export interface ModelStore {
  load(cfg: LoadModelConfig, ownerId: string | null): Promise<LoadResult>;
  /** 把内存中的行数据整体替换为同名模型 */
  loadRows(cfg: LoadRowsConfig, ownerId: string | null): Promise<LoadResult>;
  /** 从 Parquet 文件整体替换为同名模型（Data Model 输出节点使用） */
  importParquet(cfg: ImportParquetConfig): Promise<LoadResult>;
  query(name: string, limit?: number): Promise<QueryResult>;
  /** 数据探索：在模型库上执行只读 SQL（调用方须先做只读校验） */
  rawQuery(sqlText: string, limit?: number): Promise<QueryResult>;
  pivot(req: PivotSpec): Promise<PivotResult>;
  distinctValues(name: string, field: string, limit?: number): Promise<DistinctResult>;
  stats(name: string): Promise<StatsResult>;
  rename(oldName: string, newName: string): Promise<void>;
  remove(name: string): Promise<void>;
  close(): void;
}

/** 透视可用的聚合函数白名单（下推到 DuckDB 执行）。 */
export type PivotAgg = 'sum' | 'count' | 'avg' | 'min' | 'max';

export const PIVOT_AGGS: readonly PivotAgg[] = ['sum', 'count', 'avg', 'min', 'max'];

const AGG_SQL: Record<PivotAgg, string> = {
  sum: 'SUM',
  count: 'COUNT',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
};

export interface PivotValueSpec {
  field: string;
  agg: PivotAgg;
}

export interface PivotFilterSpec {
  /** 值为空数组表示不过滤（等同全部值） */
  field: string;
  values: string[];
}

export interface PivotSpec {
  name: string;
  /** Y 轴：行维度字段 */
  rows: string[];
  /** X 轴：列维度字段 */
  columns: string[];
  values: PivotValueSpec[];
  filters: PivotFilterSpec[];
  limit?: number;
}

/** 透视分组结果行上限（超过则截断并由前端提示） */
const PIVOT_DEFAULT_LIMIT = 20000;
const PIVOT_MAX_LIMIT = 50000;
/** 单列 DISTINCT 候选值上限 */
const DISTINCT_DEFAULT_LIMIT = 200;
const DISTINCT_MAX_LIMIT = 1000;

export interface PivotResult {
  /** 行维度字段（顺序即标签层级顺序） */
  rowFields: string[];
  /** 列维度字段 */
  columnFields: string[];
  values: Array<PivotValueSpec & { label: string }>;
  /** 结果列：r0… / c0… / v0…（前端按位置与上面字段顺序对应） */
  columns: QueryColumn[];
  /** 每行：[行键…, 列键…, 度量值…] */
  rows: QueryCell[][];
  truncated: boolean;
  /** 模型总行数（本次聚合覆盖全量行） */
  totalRows: number;
}

export interface DistinctResult {
  values: QueryCell[];
  truncated: boolean;
  /** 该字段在模型中的去重值总量是否超过上限 */
  limit: number;
}

/** 单列统计信息（数值列额外带 min/max/avg/median/stddev） */
export interface ColumnStats {
  name: string;
  type: string;
  numeric: boolean;
  /** 非空值个数 */
  nonNull: number;
  /** 空值个数 */
  nulls: number;
  /** 不重复值个数（不含空值） */
  distinct: number;
  min?: QueryCell;
  max?: QueryCell;
  avg?: number | null;
  median?: number | null;
  stddev?: number | null;
}

export interface StatsResult {
  name: string;
  rowCount: number;
  columns: ColumnStats[];
}

/** 数值列判定：DuckDB 原生类型名（DESCRIBE 的 column_type） */
const NUMERIC_TYPE_RE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;

/** SQL 字符串字面量：单引号翻倍转义（标准 SQL，DuckDB 默认不启用反斜杠转义）。 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 组装透视 SQL：分组与聚合全部下推给 DuckDB。
 * castFields：被配置为「数字」但原始类型非数值的列，聚合前先 TRY_CAST 成 DOUBLE。
 */
function buildPivotSql(req: PivotSpec, limit: number, castFields: Set<string>): string {
  // 别名固定为 r0…/c0…/v0…，避免同一字段同时出现在行列两侧时重名
  const rowAliases = req.rows.map((_, i) => `r${i}`);
  const colAliases = req.columns.map((_, j) => `c${j}`);
  const measureExpr = (field: string): string =>
    castFields.has(field)
      ? `TRY_CAST(${quoteIdent(field)} AS DOUBLE)`
      : quoteIdent(field);
  const selects = [
    ...req.rows.map((f, i) => `${quoteIdent(f)} AS ${quoteIdent(rowAliases[i])}`),
    ...req.columns.map((f, j) => `${quoteIdent(f)} AS ${quoteIdent(colAliases[j])}`),
    ...req.values.map((v, k) => `${AGG_SQL[v.agg]}(${measureExpr(v.field)}) AS ${quoteIdent(`v${k}`)}`),
  ];
  const groupBy = [...rowAliases, ...colAliases].map((a) => quoteIdent(a));
  const wheres = req.filters
    .filter((f) => f.values.length > 0)
    .map((f) => `${quoteIdent(f.field)} IN (${f.values.map(sqlLiteral).join(', ')})`);

  const parts = [`SELECT ${selects.join(', ')} FROM ${quoteIdent(req.name)}`];
  if (wheres.length > 0) parts.push(`WHERE ${wheres.join(' AND ')}`);
  if (groupBy.length > 0) parts.push(`GROUP BY ${groupBy.join(', ')}`);
  // 稳定顺序：前端按出现顺序拼矩阵，结果可复现
  if (groupBy.length > 0) parts.push(`ORDER BY ${groupBy.join(', ')}`);
  parts.push(`LIMIT ${limit}`);
  return parts.join(' ');
}

/** 模型已知列名集合（用于字段白名单校验，杜绝任意标识符进入 SQL）。 */
function knownColumns(repo: ReturnType<typeof dataModelsRepo>, name: string): Set<string> | null {
  const row = repo.findByName(name);
  if (!row) return null;
  return new Set((JSON.parse(row.columns) as ColumnInfo[]).map((c) => c.name));
}

/** 按列的首个非空值推断类型（规则与 modules/data/query.ts 一致，另兼容 DuckDB BIGINT）。 */
function inferColumnType(values: unknown[]): QueryColumn['type'] {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'bigint') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (v instanceof Date) return 'date';
    if (typeof v === 'string') return Number.isNaN(Date.parse(v)) ? 'string' : 'date';
    return 'string';
  }
  return 'unknown';
}

/** 安全整数范围内的 bigint 转 number，超出则保留字符串，避免精度丢失。 */
const MAX_SAFE = 9007199254740991n;

function toCell(v: unknown): QueryCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v >= -MAX_SAFE && v <= MAX_SAFE ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/** 把点号分隔的对象名逐段加引号（支持 `sales` 与 `dbo.sales`）。 */
function quoteObjectName(object: string): string {
  return object
    .split('.')
    .map((part) => quoteIdent(part.trim()))
    .join('.');
}

export function createModelStore(deps: { db: Database; config: AppConfig }): ModelStore {
  const { db, config } = deps;
  const repo = dataModelsRepo(db);
  const columnConfigs = modelColumnConfigsRepo(db);
  const connections = connectionsRepo(db);
  // DuckDB 单文件只允许单写者：所有读写串行
  const sem = createSemaphore(1);

  /** 读取模型的列类型配置（无配置返回空对象） */
  function columnTypeOverrides(name: string): Record<string, LogicalColumnType> {
    return parseColumnTypeConfig(columnConfigs.get(name)?.columns ?? null);
  }

  /** 需要先 TRY_CAST 成 DOUBLE 的度量列：被配置为数字、但 DuckDB 原始类型不是数值。 */
  function numericCastFields(name: string): Set<string> {
    const info = repo.findByName(name);
    if (!info) return new Set();
    const overrides = columnTypeOverrides(name);
    const columns = JSON.parse(info.columns) as ColumnInfo[];
    return new Set(
      columns
        .filter((c) => overrides[c.name] === 'number' && !NUMERIC_TYPE_RE.test(c.type))
        .map((c) => c.name),
    );
  }

  let session: DuckSession | null = null;
  async function conn(): Promise<DuckConnection> {
    if (!session) session = await openModelDb(config.modelDbFile);
    return session!.connection;
  }

  async function doLoad(cfg: LoadModelConfig, ownerId: string | null): Promise<LoadResult> {
    const connection = await conn();
    const staging = `__stg_${nanoid(8)}`;
    let sourceKind: ModelSourceKind = 'csv';
    let sourceRef: Record<string, unknown> = {};
    let rowCount = 0;
    let columns: ColumnInfo[] = [];
    try {
      if (cfg.source === 'file') {
        const abs = resolveResourcePath(config.resourceDir, cfg.resourcePath);
        const format = cfg.format ?? (path.extname(abs).toLowerCase() === '.csv' ? 'csv' : 'excel');
        if (!fs.existsSync(abs)) throw new Error(`资源文件不存在：${cfg.resourcePath}`);
        if (format === 'csv') {
          rowCount = await loadCsvInto(connection, staging, {
            path: abs,
            delimiter: cfg.delimiter,
            hasHeader: cfg.hasHeader,
            encoding: cfg.encoding,
          });
        } else {
          rowCount = await loadExcelInto(connection, staging, {
            path: abs,
            sheet: cfg.sheet,
            hasHeader: cfg.hasHeader,
          });
        }
        sourceKind = format;
        sourceRef = { resourcePath: cfg.resourcePath, format };
      } else {
        const row = connections.findById(cfg.connectionId);
        if (!row) throw new Error('连接不存在');
        const connConfig = decryptConfig(
          row.config_encrypted,
          config.encryptionKey,
        ) as unknown as SqlServerConnection;
        const object = cfg.object?.trim();
        const query = cfg.query?.trim()
          ? cfg.query.trim()
          : object
            ? `SELECT * FROM ${quoteObjectName(object)}`
            : '';
        if (!query) throw new Error('需要指定表或查询');
        rowCount = await loadSqlServerInto(connection, staging, { connection: connConfig, query });
        sourceKind = 'sqlserver';
        sourceRef = {
          connectionId: cfg.connectionId,
          ...(object ? { object } : {}),
          ...(cfg.query ? { query: cfg.query } : {}),
        };
      }
      columns = await describeTable(connection, staging);
      await promoteStagingTable(connection, cfg.modelName, staging);
    } catch (err) {
      await dropTable(connection, staging).catch(() => undefined);
      throw err;
    }
    repo.upsert({
      name: cfg.modelName,
      sourceKind,
      sourceRef: JSON.stringify(sourceRef),
      ownerId,
      loadedAt: Date.now(),
      rowCount,
      columns: JSON.stringify(columns),
    });
    return { rowCount, columns };
  }

  async function doLoadRows(
    cfg: LoadRowsConfig,
    ownerId: string | null,
  ): Promise<LoadResult> {
    const connection = await conn();
    const staging = `__stg_${nanoid(8)}`;
    let rowCount = 0;
    let columns: ColumnInfo[] = [];
    try {
      rowCount = await materializeRows(connection, staging, cfg.rows, cfg.columns);
      columns = await describeTable(connection, staging);
      await promoteStagingTable(connection, cfg.modelName, staging);
    } catch (err) {
      await dropTable(connection, staging).catch(() => undefined);
      throw err;
    }
    repo.upsert({
      name: cfg.modelName,
      sourceKind: cfg.sourceKind,
      sourceRef: JSON.stringify(cfg.sourceRef),
      ownerId,
      loadedAt: Date.now(),
      rowCount,
      columns: JSON.stringify(columns),
    });
    return { rowCount, columns };
  }

  async function doImportParquet(cfg: ImportParquetConfig): Promise<LoadResult> {
    if (!MODEL_NAME_RE.test(cfg.modelName)) {
      throw new Error(`数据模型名称不合法：${cfg.modelName}`);
    }
    const connection = await conn();
    const staging = `__stg_${nanoid(8)}`;
    let rowCount = 0;
    let columns: ColumnInfo[] = [];
    try {
      await connection.run(
        `CREATE TABLE ${quoteIdent(staging)} AS
         SELECT * FROM read_parquet(${sqlLiteral(cfg.parquetPath)})`,
      );
      columns = await describeTable(connection, staging);
      rowCount = await countRows(connection, staging);
      await promoteStagingTable(connection, cfg.modelName, staging);
    } catch (err) {
      await dropTable(connection, staging).catch(() => undefined);
      throw err;
    }
    repo.upsert({
      name: cfg.modelName,
      sourceKind: 'workflow',
      sourceRef: JSON.stringify(cfg.sourceRef ?? {}),
      ownerId: null,
      loadedAt: Date.now(),
      rowCount,
      columns: JSON.stringify(columns),
    });
    return { rowCount, columns };
  }

  async function doQuery(name: string, limit?: number): Promise<QueryResult> {
    const connection = await conn();
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const total = await countRows(connection, name);
    const reader = await connection.runAndReadAll(
      `SELECT * FROM ${quoteIdent(name)} LIMIT ${cap}`,
    );
    const names = reader.columnNames();
    const raw = reader.getRowsJS() as unknown[][];
    // 类型配置优先：命中配置的列按配置类型返回，并按该类型转换值
    const overrides = columnTypeOverrides(name);
    const columns: QueryColumn[] = names.map((col, i) => {
      const override = overrides[col];
      return {
        name: col,
        type: override ? toQueryColumnType(override) : inferColumnType(raw.map((r) => r[i])),
      };
    });
    const rows = raw.map((r) =>
      r.map((v, i) => {
        const override = overrides[names[i]];
        const cell = toCell(v);
        return override ? coerceCell(cell, override) : cell;
      }),
    );
    return { columns, rows, truncated: total > rows.length };
  }

  /** 数据探索：在模型库上执行只读 SQL（表名即模型名，可 join 多个模型）。 */
  async function doRawQuery(sqlText: string, limit?: number): Promise<QueryResult> {
    const connection = await conn();
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    // 去掉结尾分号后包一层子查询，用 LIMIT 限制真正读入内存的行数
    const body = sqlText.trim().replace(/[\s;]+$/, '');
    const reader = await connection.runAndReadAll(
      `SELECT * FROM (${body}) AS __explore_sub LIMIT ${cap + 1}`,
    );
    const names = reader.columnNames();
    const raw = reader.getRowsJS() as unknown[][];
    const columns: QueryColumn[] = names.map((col, i) => ({
      name: col,
      type: inferColumnType(raw.map((r) => r[i])),
    }));
    const truncated = raw.length > cap;
    const rows = raw.slice(0, cap).map((r) => r.map((v) => toCell(v)));
    return { columns, rows, truncated };
  }

  async function doPivot(req: PivotSpec): Promise<PivotResult> {
    const connection = await conn();
    const known = knownColumns(repo, req.name);
    if (!known) throw new Error('模型不存在');
    const requested = [
      ...req.rows,
      ...req.columns,
      ...req.values.map((v) => v.field),
      ...req.filters.map((f) => f.field),
    ];
    const unknown = requested.find((f) => !known.has(f));
    if (unknown) throw new Error(`未知字段：${unknown}`);

    const cap = Math.min(Math.max(Number(req.limit) || PIVOT_DEFAULT_LIMIT, 1), PIVOT_MAX_LIMIT);
    const total = await countRows(connection, req.name);
    // 多取一行用于判定是否被截断
    const reader = await connection.runAndReadAll(
      buildPivotSql(req, cap + 1, numericCastFields(req.name)),
    );
    const names = reader.columnNames();
    const raw = reader.getRowsJS() as unknown[][];
    const truncated = raw.length > cap;
    const kept = truncated ? raw.slice(0, cap) : raw;
    const columns: QueryColumn[] = names.map((col, i) => ({
      name: col,
      type: inferColumnType(kept.map((r) => r[i])),
    }));

    return {
      rowFields: [...req.rows],
      columnFields: [...req.columns],
      values: req.values.map((v) => ({ ...v, label: `${v.agg}(${v.field})` })),
      columns,
      rows: kept.map((r) => r.map((v) => toCell(v))),
      truncated,
      totalRows: total,
    };
  }

  async function doDistinctValues(
    name: string,
    field: string,
    limit?: number,
  ): Promise<DistinctResult> {
    const connection = await conn();
    const known = knownColumns(repo, name);
    if (!known) throw new Error('模型不存在');
    if (!known.has(field)) throw new Error(`未知字段：${field}`);

    const cap = Math.min(Math.max(Number(limit) || DISTINCT_DEFAULT_LIMIT, 1), DISTINCT_MAX_LIMIT);
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT ${quoteIdent(field)} AS v FROM ${quoteIdent(name)} ORDER BY 1 LIMIT ${cap + 1}`,
    );
    const raw = reader.getRowsJS() as unknown[][];
    const truncated = raw.length > cap;
    const kept = truncated ? raw.slice(0, cap) : raw;
    return { values: kept.map((r) => toCell(r[0])), truncated, limit: cap };
  }

  /** 全表统计 SQL：所有列一次扫描算完，数值列追加五个统计量；配置为数字的文本列先 TRY_CAST。 */
  function buildStatsSql(
    name: string,
    columns: ColumnInfo[],
    rawColumns: ColumnInfo[],
  ): string {
    const selects = ['COUNT(*) AS n'];
    columns.forEach((c, i) => {
      const col = quoteIdent(c.name);
      const rawType = rawColumns[i]?.type ?? c.type;
      const numeric = NUMERIC_TYPE_RE.test(c.type);
      // 类型配置为数字、但底层是文本时，聚合前显式转数字，避免 AVG/MEDIAN 报错
      const expr = numeric && !NUMERIC_TYPE_RE.test(rawType) ? `TRY_CAST(${col} AS DOUBLE)` : col;
      selects.push(`COUNT(${col}) AS c${i}_nonnull`);
      selects.push(`COUNT(*) - COUNT(${col}) AS c${i}_nulls`);
      selects.push(`COUNT(DISTINCT ${col}) AS c${i}_distinct`);
      if (numeric) {
        selects.push(`MIN(${expr}) AS c${i}_min`);
        selects.push(`MAX(${expr}) AS c${i}_max`);
        selects.push(`AVG(${expr}) AS c${i}_avg`);
        selects.push(`MEDIAN(${expr}) AS c${i}_median`);
        selects.push(`STDDEV_SAMP(${expr}) AS c${i}_stddev`);
      }
    });
    return `SELECT ${selects.join(', ')} FROM ${quoteIdent(name)}`;
  }

  async function doStats(name: string): Promise<StatsResult> {
    const info = repo.findByName(name);
    if (!info) throw new Error('模型不存在');
    const rawColumns = JSON.parse(info.columns) as ColumnInfo[];
    const columns = mergeColumnTypes(rawColumns, columnTypeOverrides(name));
    const connection = await conn();
    const reader = await connection.runAndReadAll(buildStatsSql(name, columns, rawColumns));
    const record = (reader.getRowObjectsJS() as Array<Record<string, unknown>>)[0] ?? {};
    const count = (v: unknown): number => Number(v ?? 0);
    const maybeNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

    return {
      name,
      rowCount: count(record.n),
      columns: columns.map((c, i) => {
        const numeric = NUMERIC_TYPE_RE.test(c.type);
        const base: ColumnStats = {
          name: c.name,
          type: c.type,
          numeric,
          nonNull: count(record[`c${i}_nonnull`]),
          nulls: count(record[`c${i}_nulls`]),
          distinct: count(record[`c${i}_distinct`]),
        };
        if (!numeric) return base;
        return {
          ...base,
          min: toCell(record[`c${i}_min`]),
          max: toCell(record[`c${i}_max`]),
          avg: maybeNumber(record[`c${i}_avg`]),
          median: maybeNumber(record[`c${i}_median`]),
          stddev: maybeNumber(record[`c${i}_stddev`]),
        };
      }),
    };
  }

  async function doRename(oldName: string, newName: string): Promise<void> {
    const connection = await conn();
    await connection.run(`ALTER TABLE ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)}`);
    repo.rename(oldName, newName);
    // 列类型配置按模型名映射，重命名后同步迁移
    columnConfigs.rename(oldName, newName);
  }

  async function doRemove(name: string): Promise<void> {
    const connection = await conn();
    await dropTable(connection, name);
    repo.remove(name);
    columnConfigs.remove(name);
  }

  return {
    load: (cfg, ownerId) => sem.run(() => doLoad(cfg, ownerId)),
    loadRows: (cfg, ownerId) => sem.run(() => doLoadRows(cfg, ownerId)),
    importParquet: (cfg) => sem.run(() => doImportParquet(cfg)),
    query: (name, limit) => sem.run(() => doQuery(name, limit)),
    rawQuery: (sqlText, limit) => sem.run(() => doRawQuery(sqlText, limit)),
    pivot: (req) => sem.run(() => doPivot(req)),
    distinctValues: (name, field, limit) => sem.run(() => doDistinctValues(name, field, limit)),
    stats: (name) => sem.run(() => doStats(name)),
    rename: (oldName, newName) => sem.run(() => doRename(oldName, newName)),
    remove: (name) => sem.run(() => doRemove(name)),
    close() {
      closeSession(session);
      session = null;
    },
  };
}
