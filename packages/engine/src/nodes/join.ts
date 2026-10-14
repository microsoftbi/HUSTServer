import type { JoinConfig, JoinType } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows, describeTable } from '../engine/duckdb.js';
import { quoteIdent } from '../util/sqlIdent.js';

const JOIN_KEYWORD: Record<JoinType, string> = {
  inner: 'INNER JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL OUTER JOIN',
};

export const join: NodeExecutor = async (ctx) => {
  const leftTable = ctx.inputs['left'];
  const rightTable = ctx.inputs['right'];
  if (!leftTable || !rightTable) {
    throw new Error('Join 节点需要同时连接左、右两个输入');
  }

  const cfg = ctx.node.config as unknown as JoinConfig;
  const joinType: JoinType = cfg?.joinType ?? 'inner';
  if (!cfg?.leftKey || !cfg?.rightKey) throw new Error('Join 节点缺少连接键');

  const keyword = JOIN_KEYWORD[joinType];
  if (!keyword) throw new Error(`不支持的 Join 类型：${joinType}`);

  const selectList = await buildSelectList(ctx, leftTable, rightTable, cfg);

  await ctx.connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(ctx.outputTable)} AS
     SELECT ${selectList}
     FROM ${quoteIdent(leftTable)} AS l
     ${keyword} ${quoteIdent(rightTable)} AS r
     ON l.${quoteIdent(cfg.leftKey)} = r.${quoteIdent(cfg.rightKey)}`,
  );
  const rowCount = await countRows(ctx.connection, ctx.outputTable);
  ctx.log('success', `Join 完成（${joinType}）：${rowCount} 行`);
  return { rowCount };
};

async function buildSelectList(
  ctx: Parameters<NodeExecutor>[0],
  leftTable: string,
  rightTable: string,
  cfg: JoinConfig,
): Promise<string> {
  const configured = cfg.selectFields ?? [];
  if (configured.length > 0) {
    const included = configured.filter((f) => f.include !== false);
    if (included.length === 0) throw new Error('Join 节点未选择任何输出字段');
    return included
      .map((f) => {
        const side = f.side === 'right' ? 'r' : 'l';
        const alias = f.alias && f.alias.length > 0 ? f.alias : f.source;
        return `${side}.${quoteIdent(f.source)} AS ${quoteIdent(alias)}`;
      })
      .join(', ');
  }

  const leftColumns = await describeTable(ctx.connection, leftTable);
  const rightColumns = await describeTable(ctx.connection, rightTable);
  const used = new Set<string>();
  const parts: string[] = [];

  for (const column of leftColumns) {
    parts.push(`l.${quoteIdent(column.name)} AS ${quoteIdent(column.name)}`);
    used.add(column.name);
  }
  for (const column of rightColumns) {
    let alias = column.name;
    if (used.has(alias)) alias = `right_${alias}`;
    let candidate = alias;
    let i = 2;
    while (used.has(candidate)) {
      candidate = `${alias}_${i}`;
      i += 1;
    }
    used.add(candidate);
    parts.push(`r.${quoteIdent(column.name)} AS ${quoteIdent(candidate)}`);
  }

  return parts.join(', ');
}
