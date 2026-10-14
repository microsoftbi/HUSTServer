import type { DuckDBConnection } from '@duckdb/node-api';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';
import { safeUnlink, tempPath, writeNdjson } from '../util/io.js';
import { countRows } from './duckdb.js';

/**
 * 把一批行数据物化为 DuckDB 表。
 * 通过 NDJSON 中转，统一处理 bigint / Date / Buffer 等类型，避免 Appender 类型匹配问题。
 */
export async function materializeRows(
  connection: DuckDBConnection,
  table: string,
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): Promise<number> {
  if (rows.length === 0) {
    if (columns && columns.length > 0) {
      const defs = columns.map((c) => `${quoteIdent(c)} VARCHAR`).join(', ');
      await connection.run(`CREATE OR REPLACE TABLE ${quoteIdent(table)} (${defs})`);
      return 0;
    }
    await connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT NULL AS "__empty" WHERE FALSE`,
    );
    return 0;
  }

  const tmp = tempPath('.ndjson');
  try {
    await writeNdjson(tmp, rows);
    await connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS
       SELECT * FROM read_json_auto(${quoteString(tmp)}, format = 'newline_delimited', sample_size = -1, union_by_name = true)`,
    );
    return await countRows(connection, table);
  } finally {
    safeUnlink(tmp);
  }
}
