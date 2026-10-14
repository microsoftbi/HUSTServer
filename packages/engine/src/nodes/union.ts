import type { UnionConfig, UnionMatchMode } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable, type ColumnInfo } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

/**
 * 计算 Union 输出列：按列名取并集（按端口顺序首次出现排序）或按位置对齐
 * （列名取第一个拥有该位置的端口，重名加 `_2` 后缀去重）。前端 schema.ts 镜像同一算法。
 */
export function mergeUnionColumns(
  ports: ColumnInfo[][],
  matchMode: UnionMatchMode,
): ColumnInfo[] {
  if (matchMode === 'position') {
    const maxLen = ports.reduce((max, cols) => Math.max(max, cols.length), 0);
    const used = new Set<string>();
    const out: ColumnInfo[] = [];
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
  const out: ColumnInfo[] = [];
  for (const cols of ports) {
    for (const col of cols) {
      if (seen.has(col.name)) continue;
      seen.add(col.name);
      out.push({ name: col.name, type: col.type });
    }
  }
  return out;
}

export const union: NodeExecutor = async (ctx) => {
  const cfg = ctx.node.config as unknown as UnionConfig;
  const matchMode: UnionMatchMode = cfg?.matchMode ?? 'name';
  const dedup = cfg?.dedup === true;

  // 单输入端口按连线顺序收集全部上游表。
  const tables: string[] = [];
  for (const handle of Object.keys(ctx.inputLists)) {
    tables.push(...ctx.inputLists[handle]);
  }
  if (tables.length < 2) throw new Error('Union 节点至少需要连接两个输入');

  const portColumns: ColumnInfo[][] = [];
  for (const table of tables) {
    portColumns.push(await describeTable(ctx.connection, table));
  }
  const outColumns = mergeUnionColumns(portColumns, matchMode);
  if (outColumns.length === 0) throw new Error('Union 节点没有可用列');

  // 每个端口生成一条列数/列名一致（按 outColumns）的 SELECT，便于 UNION ALL。
  const selects = tables.map((table, portIndex) => {
    const cols = portColumns[portIndex];
    const byName = new Map(cols.map((c) => [c.name, c]));
    const exprs = outColumns.map((outCol, pos) => {
      if (matchMode === 'position') {
        const src = cols[pos];
        return src
          ? `${quoteIdent(src.name)} AS ${quoteIdent(outCol.name)}`
          : `NULL AS ${quoteIdent(outCol.name)}`;
      }
      return byName.has(outCol.name)
        ? `${quoteIdent(outCol.name)} AS ${quoteIdent(outCol.name)}`
        : `NULL AS ${quoteIdent(outCol.name)}`;
    });
    return `SELECT ${exprs.join(', ')} FROM ${quoteIdent(table)}`;
  });

  const merged =
    `SELECT ${dedup ? 'DISTINCT ' : ''}* FROM (\n` +
    `  ${selects.join('\n  UNION ALL\n  ')}\n` +
    `) AS u`;

  // 输出字段投影：配置为空则输出全部合并列。
  const configured = cfg?.selectFields ?? [];
  let projection = '*';
  if (configured.length > 0) {
    const included = configured.filter((f) => f && f.include !== false);
    if (included.length === 0) throw new Error('Union 节点未选择任何输出字段');
    const available = new Set(outColumns.map((c) => c.name));
    projection = included
      .map((f) => {
        if (!available.has(f.source)) {
          throw new Error(`Union 输出字段配置引用了不存在的列：${f.source}`);
        }
        const alias = f.alias && f.alias.length > 0 ? f.alias : f.source;
        return `${quoteIdent(f.source)} AS ${quoteIdent(alias)}`;
      })
      .join(', ');
  }

  const sql =
    projection === '*'
      ? `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS SELECT * FROM (\n${merged}\n) AS b`
      : `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS SELECT ${projection} FROM (\n${merged}\n) AS b`;

  await ctx.connection.run(sql);
  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  const modeLabel = matchMode === 'name' ? '按列名' : '按位置';
  ctx.log(
    'success',
    `Union 完成（${modeLabel}${dedup ? '，去重' : ''}，${tables.length} 个输入）：${rowCount} 行`,
  );
  return { rowCount };
};
