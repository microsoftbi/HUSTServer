import type { NodeKind } from '../types.js';
import type { NodeExecutor } from '../nodes/context.js';
import { inputCsv } from '../nodes/inputCsv.js';
import { inputExcel } from '../nodes/inputExcel.js';
import { inputSqlServer } from '../nodes/inputSqlServer.js';
import { select } from '../nodes/select.js';
import { filter } from '../nodes/filter.js';
import { join } from '../nodes/join.js';
import { union } from '../nodes/union.js';
import { aggregation } from '../nodes/aggregation.js';
import { sort } from '../nodes/sort.js';
import { outputCsv } from '../nodes/outputCsv.js';
import { outputExcel } from '../nodes/outputExcel.js';
import { outputSqlServer } from '../nodes/outputSqlServer.js';
import { browser } from '../nodes/browser.js';

/** NodeKind → 执行器 的注册表。 */
export const nodeRegistry: Record<NodeKind, NodeExecutor> = {
  inputCsv,
  inputExcel,
  inputSqlServer,
  select,
  filter,
  join,
  union,
  aggregation,
  sort,
  outputCsv,
  outputExcel,
  outputSqlServer,
  browser,
};
