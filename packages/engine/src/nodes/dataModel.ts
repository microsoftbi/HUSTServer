import type { DataModelOutputConfig } from '../types.js';
import type { NodeExecutor } from './context.js';
import { countRows } from '../engine/duckdb.js';
import { safeUnlink, tempPath } from '../util/io.js';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';

/** 数据模型名即模型库表名：字母/下划线开头，仅含字母数字下划线，最长 64。 */
const MODEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Data Model 输出：把上游结果整体写出为系统数据模型。
 * 引擎不直接打开模型库（DuckDB 单文件仅允许一个写者），
 * 而是先落成 Parquet 临时文件，再由宿主注入的 writeModel 写入模型库。
 */
export const dataModel: NodeExecutor = async (ctx) => {
  const inputTable = ctx.inputs['in'] ?? ctx.inputList[0];
  if (!inputTable) throw new Error('Data Model 节点缺少输入数据');

  const cfg = (ctx.node.config ?? {}) as unknown as DataModelOutputConfig;
  const modelName = cfg.modelName?.trim();
  if (!modelName) throw new Error('Data Model 节点需要指定数据模型名称');
  if (!MODEL_NAME_RE.test(modelName)) {
    throw new Error(
      `数据模型名称不合法：${modelName}（需字母或下划线开头，仅含字母、数字、下划线，最长 64 位）`,
    );
  }
  if (!ctx.writeModel) throw new Error('当前运行环境未启用数据模型写出能力');

  const onDuplicate = cfg.onDuplicate === 'error' ? 'error' : 'overwrite';
  const sourceRows = await countRows(ctx.connection, inputTable);
  const parquetPath = tempPath('.parquet');

  try {
    await ctx.connection.run(
      `COPY (SELECT * FROM ${quoteIdent(inputTable)}) TO ${quoteString(parquetPath)} (FORMAT PARQUET)`,
    );
    const result = await ctx.writeModel({ modelName, onDuplicate, parquetPath });
    ctx.log(
      'success',
      result.replaced
        ? `已覆盖数据模型「${modelName}」：${result.rowCount} 行`
        : `已新建数据模型「${modelName}」：${result.rowCount} 行`,
    );
    return { rowCount: result.rowCount, note: `源数据 ${sourceRows} 行` };
  } finally {
    safeUnlink(parquetPath);
  }
};
