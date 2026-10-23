import {
  ArrowDownUp,
  Calculator,
  Columns3,
  Combine,
  Database,
  Dices,
  Eraser,
  Eye,
  FileDown,
  FileSpreadsheet,
  FileType2,
  Filter,
  Fingerprint,
  GitMerge,
  Rows3,
  Sheet,
  Sigma,
  Split,
  Table2,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import type { NodeKind } from '@/types';

export type NodeCategory = 'input' | 'transform' | 'output';

export interface NodeHandle {
  id: string;
  label: string;
}

export interface NodeMeta {
  kind: NodeKind;
  label: string;
  category: NodeCategory;
  description: string;
  icon: LucideIcon;
  /** 目标端口（输入），id 会写入 edge.targetHandle */
  inputs: NodeHandle[];
  /** 源端口（输出），id 会写入 edge.sourceHandle；空数组表示无输出 */
  outputs: NodeHandle[];
  defaultConfig: Record<string, unknown>;
}

export const NODE_META: Record<NodeKind, NodeMeta> = {
  inputCsv: {
    kind: 'inputCsv',
    label: 'CSV',
    category: 'input',
    description: '从本地 CSV 文件读取数据',
    icon: FileSpreadsheet,
    inputs: [],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { path: '', delimiter: ',', hasHeader: true, encoding: 'utf-8' },
  },
  inputExcel: {
    kind: 'inputExcel',
    label: 'Excel',
    category: 'input',
    description: '从 Excel 工作表读取数据',
    icon: Table2,
    inputs: [],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { path: '', sheet: '', hasHeader: true },
  },
  inputSqlServer: {
    kind: 'inputSqlServer',
    label: 'SQL Server',
    category: 'input',
    description: '执行 SQL 查询读取 SQL Server 数据',
    icon: Database,
    inputs: [],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { connectionId: '', query: '' },
  },
  select: {
    kind: 'select',
    label: 'Select',
    category: 'transform',
    description: '选择、重命名并重排列',
    icon: Columns3,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { fields: [] },
  },
  filter: {
    kind: 'filter',
    label: 'Filter',
    category: 'transform',
    description: '按 SQL 布尔表达式过滤行；T 输出命中行，F 输出其余行',
    icon: Filter,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [
      { id: 'out', label: 'T' },
      { id: 'f', label: 'F' },
    ],
    defaultConfig: { expression: '' },
  },
  join: {
    kind: 'join',
    label: 'Join',
    category: 'transform',
    description: '按连接键合并两路数据',
    icon: GitMerge,
    inputs: [
      { id: 'left', label: '左' },
      { id: 'right', label: '右' },
    ],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { joinType: 'inner', leftKey: '', rightKey: '', selectFields: [] },
  },
  union: {
    kind: 'union',
    label: 'Union',
    category: 'transform',
    description: '纵向合并多路输入（单个输入端口可连接多条连线，按列名或按位置对齐，可去重）',
    icon: Combine,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { matchMode: 'name', dedup: false },
  },
  aggregation: {
    kind: 'aggregation',
    label: 'Aggregation',
    category: 'transform',
    description: '分组并聚合（Sum/Count/Max/Min/Avg）',
    icon: Calculator,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { groupBy: [], aggregations: [] },
  },
  sort: {
    kind: 'sort',
    label: 'Sort',
    category: 'transform',
    description: '按多列排序',
    icon: ArrowDownUp,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { sorts: [] },
  },
  formula: {
    kind: 'formula',
    label: 'Formula',
    category: 'transform',
    description: '用表达式新增或覆盖列，多个表达式按顺序依次计算',
    icon: Sigma,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { formulas: [] },
  },
  unique: {
    kind: 'unique',
    label: 'Unique',
    category: 'transform',
    description: '按选定字段判断唯一值；U 输出每组首行，D 输出其余重复行',
    icon: Fingerprint,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [
      { id: 'out', label: 'U' },
      { id: 'd', label: 'D' },
    ],
    defaultConfig: { fields: [] },
  },
  sample: {
    kind: 'sample',
    label: 'Sample',
    category: 'transform',
    description: '前 N 行 / 后 N 行 / 跳过 / 每隔 / 随机 / 百分比抽样，可按列分组',
    icon: Dices,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { mode: 'first', n: 100, groupBy: [] },
  },
  cleansing: {
    kind: 'cleansing',
    label: 'Data Cleansing',
    category: 'transform',
    description: '替换空值、去除多余字符与空格、修改大小写，可移除空行空列',
    icon: Eraser,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: {
      fields: [],
      removeNullRows: false,
      nullRowMode: 'all',
      removeNullColumns: false,
      nullColumnMode: 'all',
      replaceNullString: true,
      replaceNullNumber: true,
      trimWhitespace: true,
      reduceWhitespace: false,
      removeAllWhitespace: false,
      removeLetters: false,
      removeNumbers: false,
      removePunctuation: false,
      caseMode: 'none',
    },
  },
  runningTotal: {
    kind: 'runningTotal',
    label: 'Running Total',
    category: 'transform',
    description: '按记录顺序累加数值字段，可按分组字段重新开始累计',
    icon: TrendingUp,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { groupBy: [], items: [] },
  },
  textToColumns: {
    kind: 'textToColumns',
    label: 'Text to Columns',
    category: 'transform',
    description: '按分隔符把单个字段拆成多列或多行',
    icon: Split,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: {
      field: '',
      delimiter: ',',
      mode: 'columns',
      rootName: '',
      skipEmpty: false,
      maxColumns: 0,
    },
  },
  crossTab: {
    kind: 'crossTab',
    label: 'Cross Tab',
    category: 'transform',
    description: '把表头字段的取值转成列，值字段填入交叉单元格',
    icon: Table2,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: {
      groupBy: [],
      headerField: '',
      valueField: '',
      method: 'first',
      prefix: '',
    },
  },
  transpose: {
    kind: 'transpose',
    label: 'Transpose',
    category: 'transform',
    description: '把选定的数据列转成行，输出键字段 + Name + Value',
    icon: Rows3,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [{ id: 'out', label: '输出' }],
    defaultConfig: { keyFields: [], dataFields: [] },
  },
  dataModel: {
    kind: 'dataModel',
    label: 'Data Model',
    category: 'output',
    description: '把结果写成本系统的数据模型，可指定重名时覆盖或报错',
    icon: Database,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [],
    defaultConfig: { modelName: '', onDuplicate: 'overwrite' },
  },
  outputCsv: {
    kind: 'outputCsv',
    label: 'CSV',
    category: 'output',
    description: '写出 CSV 文件',
    icon: FileDown,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [],
    defaultConfig: { path: 'output.csv', delimiter: ',', hasHeader: true },
  },
  outputExcel: {
    kind: 'outputExcel',
    label: 'Excel',
    category: 'output',
    description: '写出 Excel 工作表',
    icon: Sheet,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [],
    defaultConfig: { path: 'output.xlsx', sheet: 'Sheet1' },
  },
  outputSqlServer: {
    kind: 'outputSqlServer',
    label: 'SQL Server',
    category: 'output',
    description: '写入 SQL Server 表',
    icon: FileType2,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [],
    defaultConfig: {
      connectionId: '',
      table: '',
      mode: 'append',
      createTable: true,
    },
  },
  browser: {
    kind: 'browser',
    label: 'Browser',
    category: 'output',
    description: '查看上游数据；运行后点击节点可查看全部缓存数据',
    icon: Eye,
    inputs: [{ id: 'in', label: '输入' }],
    outputs: [],
    defaultConfig: {},
  },
};

export const NODE_CATEGORY_LABEL: Record<NodeCategory, string> = {
  input: '输入',
  transform: '转换',
  output: '输出',
};

/** 分类强调色（用于节点卡片顶部色条与图标底色） */
export const CATEGORY_ACCENT: Record<NodeCategory, string> = {
  input: 'bg-sky-500',
  transform: 'bg-violet-500',
  output: 'bg-emerald-500',
};

export function getNodeMeta(kind: NodeKind): NodeMeta {
  return NODE_META[kind];
}
