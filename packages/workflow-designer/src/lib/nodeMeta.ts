import {
  ArrowDownUp,
  Calculator,
  Columns3,
  Combine,
  Database,
  Eye,
  FileDown,
  FileSpreadsheet,
  FileType2,
  Filter,
  GitMerge,
  Sheet,
  Table2,
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

const DEFAULT_SQL_CONNECTION = {
  server: '',
  port: 1433,
  database: '',
  user: '',
  password: '',
  encrypt: true,
  trustServerCertificate: true,
};

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
    defaultConfig: { connection: { ...DEFAULT_SQL_CONNECTION }, query: '' },
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
      connection: { ...DEFAULT_SQL_CONNECTION },
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
