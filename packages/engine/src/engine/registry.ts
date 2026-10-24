import type { NodeKind } from '../types.js';
import type { NodeExecutor } from '../nodes/context.js';
import { inputCsv } from '../nodes/inputCsv.js';
import { inputExcel } from '../nodes/inputExcel.js';
import { inputSqlServer } from '../nodes/inputSqlServer.js';
import { textInput } from '../nodes/textInput.js';
import { select } from '../nodes/select.js';
import { filter } from '../nodes/filter.js';
import { join } from '../nodes/join.js';
import { findReplace } from '../nodes/findReplace.js';
import { union } from '../nodes/union.js';
import { aggregation } from '../nodes/aggregation.js';
import { sort } from '../nodes/sort.js';
import { formula } from '../nodes/formula.js';
import { unique } from '../nodes/unique.js';
import { sample } from '../nodes/sample.js';
import { cleansing } from '../nodes/cleansing.js';
import { runningTotal } from '../nodes/runningTotal.js';
import { textToColumns } from '../nodes/textToColumns.js';
import { crossTab } from '../nodes/crossTab.js';
import { transpose } from '../nodes/transpose.js';
import { dataModel } from '../nodes/dataModel.js';
import { outputCsv } from '../nodes/outputCsv.js';
import { outputExcel } from '../nodes/outputExcel.js';
import { outputSqlServer } from '../nodes/outputSqlServer.js';
import { browser } from '../nodes/browser.js';

/** NodeKind → 执行器 的注册表。 */
export const nodeRegistry: Record<NodeKind, NodeExecutor> = {
  inputCsv,
  inputExcel,
  inputSqlServer,
  textInput,
  select,
  filter,
  join,
  findReplace,
  union,
  aggregation,
  sort,
  formula,
  unique,
  sample,
  cleansing,
  runningTotal,
  textToColumns,
  crossTab,
  transpose,
  dataModel,
  outputCsv,
  outputExcel,
  outputSqlServer,
  browser,
};
