import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sql from 'mssql';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DUCKDB_MEMORY_LIMIT, SPILL_DIR, ensureDirs } from '../config.js';
import type { SqlServerConnection } from '../types.js';
import { readExcelSheet } from '../util/excel.js';
import { normalizeDelimiter } from '../util/format.js';
import { decodeFileToUtf8, resolveInputPath, safeUnlink, tempPath } from '../util/io.js';
import { buildMssqlConfig } from '../util/mssql.js';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';
import { countRows, type DuckSession } from './duckdb.js';
import { materializeRows } from './ingest.js';

export interface ModelCsvConfig {
  /** 资源文件绝对路径（调用方已解析到资源库/上传目录内）。 */
  path: string;
  delimiter?: string;
  hasHeader?: boolean;
  encoding?: 'utf-8' | 'gbk';
}

export interface ModelExcelConfig {
  path: string;
  sheet?: string;
  hasHeader?: boolean;
}

export interface ModelSqlServerConfig {
  connection: SqlServerConnection;
  query: string;
}

/**
 * 打开常驻的模型 DuckDB 文件库。
 * 参数与 createSession 完全一致，仅把 ':memory:' 换成文件路径（仍复用 SPILL_DIR / 内存上限 / 线程数）。
 */
export async function openModelDb(file: string): Promise<DuckSession> {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = await DuckDBInstance.create(file, {
    temp_directory: SPILL_DIR,
    memory_limit: DUCKDB_MEMORY_LIMIT,
    threads: String(Math.max(2, Math.min(8, os.cpus().length))),
  });
  const connection = await instance.connect();
  return { instance, connection };
}

/** 删除表（不存在则忽略）。 */
export async function dropTable(connection: DuckDBConnection, table: string): Promise<void> {
  await connection.run(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
}

/** 用 staging 表原子替换目标表；目标已存在时内容被整体替换，失败时目标保持原样。 */
export async function promoteStagingTable(
  connection: DuckDBConnection,
  target: string,
  staging: string,
): Promise<void> {
  await connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(target)} AS SELECT * FROM ${quoteIdent(staging)}`,
  );
  await dropTable(connection, staging);
}

/** 把 CSV 文件物化为指定表并返回行数；算法与输入节点 inputCsv 一致。 */
export async function loadCsvInto(
  connection: DuckDBConnection,
  table: string,
  cfg: ModelCsvConfig,
): Promise<number> {
  const sourcePath = resolveInputPath(cfg.path);
  if (!fs.existsSync(sourcePath)) throw new Error(`CSV 文件不存在：${sourcePath}`);

  const delimiter = normalizeDelimiter(cfg.delimiter);
  const hasHeader = cfg.hasHeader !== false;

  let readPath = sourcePath;
  let tempFile: string | null = null;
  if (cfg.encoding === 'gbk') {
    const text = decodeFileToUtf8(sourcePath, 'gbk');
    tempFile = tempPath('.csv');
    fs.writeFileSync(tempFile, text, 'utf-8');
    readPath = tempFile;
  }

  try {
    await connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS
       SELECT * FROM read_csv_auto(${quoteString(readPath)}, delim = ${quoteString(delimiter)}, header = ${hasHeader ? 'true' : 'false'}, sample_size = -1)`,
    );
    return await countRows(connection, table);
  } finally {
    if (tempFile) safeUnlink(tempFile);
  }
}

/** 把 Excel 工作表物化为指定表并返回行数；算法与输入节点 inputExcel 一致。 */
export async function loadExcelInto(
  connection: DuckDBConnection,
  table: string,
  cfg: ModelExcelConfig,
): Promise<number> {
  const { columns, dataRows } = readExcelSheet(cfg.path, cfg.sheet, cfg.hasHeader !== false);
  const rows = dataRows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column] = row[index] ?? null;
    });
    return record;
  });
  return materializeRows(connection, table, rows, columns);
}

/** 执行 SQL Server 查询并物化为指定表，返回行数；算法与输入节点 inputSqlServer 一致。 */
export async function loadSqlServerInto(
  connection: DuckDBConnection,
  table: string,
  cfg: ModelSqlServerConfig,
): Promise<number> {
  const pool = await new sql.ConnectionPool(buildMssqlConfig(cfg.connection)).connect();
  try {
    const result = await pool.request().query(cfg.query);
    const rows = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const columns =
      rows.length > 0
        ? Object.keys(rows[0])
        : result.recordset && result.recordset.columns
          ? Object.keys(result.recordset.columns)
          : [];
    return await materializeRows(connection, table, rows, columns);
  } finally {
    await pool.close().catch(() => undefined);
  }
}
