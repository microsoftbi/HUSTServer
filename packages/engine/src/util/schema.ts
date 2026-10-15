import fs from 'node:fs';
import sql from 'mssql';
import type { ColumnMeta, InputCsvConfig, InputExcelConfig, SqlServerConnection } from '../types.js';
import { closeSession, createSession, describeTable } from '../engine/duckdb.js';
import { normalizeDelimiter } from './format.js';
import { readExcelSheet } from './excel.js';
import { decodeFileToUtf8, resolveInputPath, safeUnlink, tempPath } from './io.js';
import { buildMssqlConfig } from './mssql.js';
import { quoteString } from './sqlIdent.js';

/** 从数据行中推断某列的粗略类型（仅用于结构预览展示）。 */
function inferType(rows: unknown[][], index: number): string {
  for (const row of rows.slice(0, 200)) {
    const value = row[index];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number') return 'DOUBLE';
    if (typeof value === 'boolean') return 'BOOLEAN';
    return 'VARCHAR';
  }
  return 'VARCHAR';
}

/** 探测 CSV 列结构（读取方式与 inputCsv 节点执行保持一致，避免两处漂移）。 */
export async function probeCsvSchema(cfg: Partial<InputCsvConfig>): Promise<ColumnMeta[]> {
  if (!cfg?.path) throw new Error('缺少文件路径');
  const sourcePath = resolveInputPath(cfg.path);
  if (!fs.existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`);

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

  const session = await createSession();
  try {
    await session.connection.run(
      `CREATE OR REPLACE VIEW __probe_csv AS
       SELECT * FROM read_csv_auto(${quoteString(readPath)}, delim = ${quoteString(delimiter)}, header = ${hasHeader ? 'true' : 'false'}, sample_size = -1)`,
    );
    return await describeTable(session.connection, '__probe_csv');
  } finally {
    closeSession(session);
    if (tempFile) safeUnlink(tempFile);
  }
}

/** 探测 Excel 列结构（复用 readExcelSheet，与 inputExcel 节点列推导一致）。 */
export function probeExcelSchema(cfg: Partial<InputExcelConfig>): ColumnMeta[] {
  if (!cfg?.path) throw new Error('缺少文件路径');
  const { columns, dataRows } = readExcelSheet(cfg.path, cfg.sheet, cfg.hasHeader !== false);
  return columns.map((name, index) => ({ name, type: inferType(dataRows, index) }));
}

/**
 * 探测 SQL Server 查询结果列。
 * 使用 `SELECT TOP 0` 仅取元数据（不返回数据行），列取自 recordset.columns。
 */
export async function probeSqlServerSchema(cfg: {
  connection: SqlServerConnection;
  query: string;
}): Promise<ColumnMeta[]> {
  if (!cfg?.query?.trim()) throw new Error('缺少查询语句');
  const pool = await new sql.ConnectionPool(buildMssqlConfig(cfg.connection)).connect();
  try {
    const result = await pool.request().query(`SELECT TOP 0 * FROM (${cfg.query}) AS __probe_sub`);
    const meta = (result.recordset?.columns ?? {}) as Record<
      string,
      { name: string; type?: { declaration?: string; name?: string } }
    >;
    return Object.values(meta).map((column) => ({
      name: String(column.name),
      type: column.type?.declaration ?? column.type?.name ?? 'unknown',
    }));
  } finally {
    await pool.close().catch(() => undefined);
  }
}
