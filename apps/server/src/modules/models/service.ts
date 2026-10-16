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
import { dataModelsRepo, type ModelSourceKind } from './repo.js';

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

export interface LoadResult {
  rowCount: number;
  columns: ColumnInfo[];
}

export interface ModelStore {
  load(cfg: LoadModelConfig, ownerId: string | null): Promise<LoadResult>;
  query(name: string, limit?: number): Promise<QueryResult>;
  rename(oldName: string, newName: string): Promise<void>;
  remove(name: string): Promise<void>;
  close(): void;
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
  const connections = connectionsRepo(db);
  // DuckDB 单文件只允许单写者：所有读写串行
  const sem = createSemaphore(1);

  let session: DuckSession | null = null;
  async function conn(): Promise<DuckConnection> {
    if (!session) session = await openModelDb(config.modelDbFile);
    return session.connection;
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

  async function doQuery(name: string, limit?: number): Promise<QueryResult> {
    const connection = await conn();
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const total = await countRows(connection, name);
    const reader = await connection.runAndReadAll(
      `SELECT * FROM ${quoteIdent(name)} LIMIT ${cap}`,
    );
    const names = reader.columnNames();
    const raw = reader.getRowsJS() as unknown[][];
    const columns: QueryColumn[] = names.map((col, i) => ({
      name: col,
      type: inferColumnType(raw.map((r) => r[i])),
    }));
    const rows = raw.map((r) => r.map((v) => toCell(v)));
    return { columns, rows, truncated: total > rows.length };
  }

  async function doRename(oldName: string, newName: string): Promise<void> {
    const connection = await conn();
    await connection.run(`ALTER TABLE ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)}`);
    repo.rename(oldName, newName);
  }

  async function doRemove(name: string): Promise<void> {
    const connection = await conn();
    await dropTable(connection, name);
    repo.remove(name);
  }

  return {
    load: (cfg, ownerId) => sem.run(() => doLoad(cfg, ownerId)),
    query: (name, limit) => sem.run(() => doQuery(name, limit)),
    rename: (oldName, newName) => sem.run(() => doRename(oldName, newName)),
    remove: (name) => sem.run(() => doRemove(name)),
    close() {
      closeSession(session);
      session = null;
    },
  };
}
