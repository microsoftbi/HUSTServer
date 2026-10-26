import { nanoid } from 'nanoid';
import type { ConnectionsRepo } from '../connections/repo.js';
import { MODEL_NAME_RE } from '../models/service.js';
import { isFreqType, validateCron, type FreqType } from '../schedules/cron.js';
import type { WorkflowsRepo } from '../workflows/repo.js';
import { assertAcyclic } from './graph.js';
import type {
  JobEdgeInput, JobEdgeRow, JobNodeInput, JobNodeMode, JobOnFailure, JobRow, JobStepRow, JobStepType,
} from './repo.js';

/** Job 导出文件的标识与版本（导入时校验，便于以后兼容旧文件） */
export const JOB_FILE_KIND = 'hustserver.job';
export const JOB_FILE_VERSION = 2;

const NODE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 导出文件中的单个节点：config 为存储格式，refs 供跨环境按名称重新匹配 */
export interface ExportedNode {
  key: string;
  type: JobStepType;
  name: string;
  onFailure: JobOnFailure;
  mode: JobNodeMode;
  x: number;
  y: number;
  config: Record<string, unknown>;
  refs?: { connectionName?: string; workflowName?: string };
}

export interface ExportedEdge {
  source: string;
  target: string;
}

export interface ExportedJobFile {
  kind: string;
  version: number;
  exportedAt: number;
  job: {
    name: string;
    description: string | null;
    schedule: {
      enabled: boolean;
      freqType: FreqType | null;
      cronExpr: string | null;
      timezone: string;
    };
    nodes: ExportedNode[];
    edges: ExportedEdge[];
    /** 仅 v1 文件包含；导入时升级为线性图 */
    steps?: unknown;
  };
}

/** v1 文件里的步骤结构，仅用于读取旧导出文件 */
interface V1ExportedStep {
  type: JobStepType;
  name: string;
  onFailure: JobOnFailure;
  config: Record<string, unknown>;
  refs?: { connectionName?: string; workflowName?: string };
}

const DEFAULT_STEP_NAMES: Record<JobStepType, string> = {
  workflow: '运行工作流',
  sql: '运行 SQL',
  load_model: '加载成模型',
};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** 组装导出文件；顺带写出连接名与工作流名，便于在另一环境按名称匹配。 */
export function buildJobFile(
  job: JobRow,
  nodes: JobStepRow[],
  edges: JobEdgeRow[],
  refs: { connections: ConnectionsRepo; workflows: WorkflowsRepo },
): ExportedJobFile {
  const keyOf = new Map<string, string>();
  const keys = new Set<string>();
  for (const n of nodes) {
    const key = n.node_key ?? n.id;
    keyOf.set(n.id, key);
    keys.add(key);
  }

  return {
    kind: JOB_FILE_KIND,
    version: JOB_FILE_VERSION,
    exportedAt: Date.now(),
    job: {
      name: job.name,
      description: job.description,
      schedule: {
        enabled: job.enabled === 1,
        freqType: job.freq_type,
        cronExpr: job.cron_expr,
        timezone: job.timezone,
      },
      nodes: nodes.map((n) => {
        const config = JSON.parse(n.config) as Record<string, unknown>;
        const ref: NonNullable<ExportedNode['refs']> = {};
        const connectionId = str(config.connectionId);
        if (connectionId) {
          const conn = refs.connections.findById(connectionId);
          if (conn) ref.connectionName = conn.name;
        }
        const workflowId = str(config.workflowId);
        if (workflowId) {
          const wf = refs.workflows.findById(workflowId);
          if (wf) ref.workflowName = wf.name;
        }
        return {
          key: keyOf.get(n.id)!,
          type: n.type,
          name: n.name,
          onFailure: n.on_failure,
          mode: n.run_mode,
          x: n.pos_x,
          y: n.pos_y,
          config,
          ...(Object.keys(ref).length > 0 ? { refs: ref } : {}),
        };
      }),
      edges: edges
        .filter((e) => keys.has(e.source_key) && keys.has(e.target_key))
        .map((e) => ({ source: e.source_key, target: e.target_key })),
    },
  };
}

export interface ParsedJobImport {
  name: string;
  description: string | null;
  enabled: boolean;
  freqType: FreqType | null;
  cronExpr: string | null;
  timezone: string;
  nodes: JobNodeInput[];
  edges: JobEdgeInput[];
  warnings: string[];
}

export type JobImportResult = { ok: true; data: ParsedJobImport } | { ok: false; error: string };

export interface ImportContext {
  connections: ConnectionsRepo;
  workflows: WorkflowsRepo;
  isAdmin: boolean;
  userId: string;
  /** 当前已存在的 Job 名（同名时自动加后缀） */
  takenNames: Set<string>;
  defaultTimezone: string;
}

/** 在当前用户可见范围内按名称匹配连接；匹配不到返回 null。 */
function matchConnection(id: unknown, name: unknown, ctx: ImportContext): string | null {
  const list = ctx.isAdmin ? ctx.connections.listAll() : ctx.connections.listForOwner(ctx.userId);
  const wanted = str(name);
  if (wanted) return list.find((c) => c.name === wanted)?.id ?? null;
  // 文件里没有名称线索时，看原 id 是否仍然可见
  const rawId = str(id);
  return rawId && list.some((c) => c.id === rawId) ? rawId : null;
}

/** 在当前用户可见范围内按名称匹配工作流；匹配不到返回 null。 */
function matchWorkflow(id: unknown, name: unknown, ctx: ImportContext): string | null {
  const list = ctx.isAdmin ? ctx.workflows.listAll() : ctx.workflows.listForOwner(ctx.userId);
  const wanted = str(name);
  if (wanted) return list.find((w) => w.name === wanted)?.id ?? null;
  const rawId = str(id);
  return rawId && list.some((w) => w.id === rawId) ? rawId : null;
}

/** 同名时依次尝试「原名 (2)」「原名 (3)」… */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

interface ParsedNodeCore {
  type: JobStepType;
  name: string;
  onFailure: JobOnFailure;
  config: string;
}

/** 解析单个节点/步骤的类型与配置；labelPrefix 用于区分 v1「步骤」与 v2「节点」文案。 */
function parseNodeCore(
  raw: unknown,
  index: number,
  ctx: ImportContext,
  warnings: string[],
  labelPrefix: '步骤' | '节点',
): { core: ParsedNodeCore } | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: `${labelPrefix} ${index + 1}：格式无效` };
  }
  const item = raw as Partial<V1ExportedStep>;
  const type = item.type;
  if (type !== 'workflow' && type !== 'sql' && type !== 'load_model') {
    return { error: `${labelPrefix} ${index + 1}：类型无效` };
  }
  const name = str(item.name) ?? DEFAULT_STEP_NAMES[type];
  const onFailure: JobOnFailure = item.onFailure === 'continue' ? 'continue' : 'abort';
  const config = (
    typeof item.config === 'object' && item.config !== null ? item.config : {}
  ) as Record<string, unknown>;
  const refs = (
    typeof item.refs === 'object' && item.refs !== null ? item.refs : {}
  ) as Record<string, unknown>;
  const label = `${labelPrefix} ${index + 1}「${name}」`;

  if (type === 'workflow') {
    const matched = matchWorkflow(config.workflowId, refs.workflowName, ctx);
    if (!matched) {
      const wanted = str(refs.workflowName) ?? str(config.workflowId) ?? '未知';
      warnings.push(`${label}引用的工作流「${wanted}」不存在，已清空，请在编辑页重新选择`);
    }
    return { core: { type, name, onFailure, config: JSON.stringify({ workflowId: matched ?? '' }) } };
  }

  if (type === 'sql') {
    const sqlText = str(config.sql);
    if (!sqlText) return { error: `${label}：SQL 不能为空` };
    const matched = matchConnection(config.connectionId, refs.connectionName, ctx);
    if (!matched) {
      const wanted = str(refs.connectionName) ?? str(config.connectionId) ?? '未知';
      warnings.push(`${label}引用的连接「${wanted}」不存在，已清空，请在编辑页重新选择`);
    }
    return {
      core: {
        type, name, onFailure,
        config: JSON.stringify({ connectionId: matched ?? '', sql: sqlText }),
      },
    };
  }

  const modelName = str(config.modelName);
  if (!modelName || !MODEL_NAME_RE.test(modelName)) return { error: `${label}：模型名不合法` };

  if (config.source === 'file') {
    const resourcePath = str(config.resourcePath);
    if (!resourcePath) return { error: `${label}：缺少资源文件路径` };
    const format = config.format === 'csv' || config.format === 'excel' ? config.format : undefined;
    return {
      core: {
        type, name, onFailure,
        config: JSON.stringify({
          source: 'file',
          modelName,
          resourcePath,
          ...(format ? { format } : {}),
        }),
      },
    };
  }

  if (config.source === 'sqlserver') {
    const object = str(config.object);
    const query = str(config.query);
    if (!object && !query) return { error: `${label}：需要数据表或自定义查询` };
    const matched = matchConnection(config.connectionId, refs.connectionName, ctx);
    if (!matched) {
      const wanted = str(refs.connectionName) ?? str(config.connectionId) ?? '未知';
      warnings.push(`${label}引用的连接「${wanted}」不存在，已清空，请在编辑页重新选择`);
    }
    return {
      core: {
        type, name, onFailure,
        config: JSON.stringify({
          source: 'sqlserver',
          modelName,
          connectionId: matched ?? '',
          ...(object ? { object } : {}),
          ...(query ? { query } : {}),
        }),
      },
    };
  }

  return { error: `${label}：数据来源无效` };
}

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** 解析 v2 的节点数组，补齐缺失坐标、重新生成非法/重复 key。 */
function parseNodes(
  rawNodes: unknown[],
  ctx: ImportContext,
  warnings: string[],
): { nodes: JobNodeInput[] } | { error: string } {
  const nodes: JobNodeInput[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < rawNodes.length; i += 1) {
    const parsed = parseNodeCore(rawNodes[i], i, ctx, warnings, '节点');
    if ('error' in parsed) return { error: parsed.error };
    const item = rawNodes[i] as Record<string, unknown>;
    const rawKey = str(item.key);
    let key = rawKey && NODE_KEY_RE.test(rawKey) && !keys.has(rawKey) ? rawKey : '';
    if (!key) {
      key = `n_${nanoid(10)}`;
      while (keys.has(key)) key = `n_${nanoid(10)}`;
      if (rawKey) warnings.push(`节点 ${i + 1}「${parsed.core.name}」的 key 无效或重复，已重新生成`);
    }
    keys.add(key);
    const mode: JobNodeMode =
      item.mode === 'skip' || item.mode === 'disable' ? item.mode : 'run';
    nodes.push({
      key,
      ...parsed.core,
      mode,
      x: finiteOr(item.x, i * 260),
      y: finiteOr(item.y, 120),
    });
  }
  return { nodes };
}

/** 解析边：丢弃指向不存在节点的边、自环与重复连线，并拒绝环。 */
function parseEdges(
  rawEdges: unknown[],
  nodes: JobNodeInput[],
  warnings: string[],
): { edges: JobEdgeInput[] } | { error: string } {
  const nodeKeys = new Set(nodes.map((n) => n.key));
  const edges: JobEdgeInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawEdges.length; i += 1) {
    const raw = rawEdges[i];
    if (typeof raw !== 'object' || raw === null) {
      warnings.push(`连线 ${i + 1}：格式无效，已忽略`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const source = str(item.source);
    const target = str(item.target);
    if (!source || !target) {
      warnings.push(`连线 ${i + 1}：格式无效，已忽略`);
      continue;
    }
    if (!nodeKeys.has(source) || !nodeKeys.has(target)) {
      warnings.push(`连线 ${source} → ${target} 指向不存在的节点，已忽略`);
      continue;
    }
    if (source === target) {
      warnings.push(`连线 ${source} → ${target} 不能连接到自身，已忽略`);
      continue;
    }
    const id = `${source}→${target}`;
    if (seen.has(id)) {
      warnings.push(`连线 ${id} 重复，已忽略`);
      continue;
    }
    seen.add(id);
    edges.push({ source, target });
  }
  try {
    assertAcyclic(nodes.map((n) => n.key), edges);
  } catch (err) {
    return { error: err instanceof Error ? err.message : '存在循环依赖' };
  }
  return { edges };
}

/** 把 v1 的线性 steps 升级成 v2 节点与线性边。 */
function upgradeV1Steps(
  rawSteps: unknown[],
  ctx: ImportContext,
  warnings: string[],
): { nodes: JobNodeInput[]; edges: JobEdgeInput[] } | { error: string } {
  const nodes: JobNodeInput[] = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const parsed = parseNodeCore(rawSteps[i], i, ctx, warnings, '步骤');
    if ('error' in parsed) return { error: parsed.error };
    nodes.push({
      key: `n_${nanoid(10)}`,
      ...parsed.core,
      mode: 'run',
      x: i * 260,
      y: 120,
    });
  }
  const edges: JobEdgeInput[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    edges.push({ source: nodes[i - 1].key, target: nodes[i].key });
  }
  return { nodes, edges };
}

/** 解析导入文件；返回可直接落库的 Job 字段与需要提示用户的告警。 */
export function parseJobFile(raw: unknown, ctx: ImportContext): JobImportResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '文件内容不是合法的 JSON 对象' };
  const file = raw as Partial<ExportedJobFile>;
  if (file.kind !== JOB_FILE_KIND) return { ok: false, error: '不是 Job 导出文件（kind 不匹配）' };
  if (file.version !== 1 && file.version !== JOB_FILE_VERSION) {
    return {
      ok: false,
      error: `不支持的文件版本：${String(file.version)}（当前支持 1, ${JOB_FILE_VERSION}）`,
    };
  }
  const job = file.job;
  if (typeof job !== 'object' || job === null) return { ok: false, error: '文件缺少 job 字段' };

  const rawName = str(job.name);
  if (!rawName) return { ok: false, error: 'Job 名称不能为空' };

  const warnings: string[] = [];
  let graph: { nodes: JobNodeInput[]; edges: JobEdgeInput[] };
  if (file.version === 1) {
    const rawSteps = Array.isArray(job.steps) ? job.steps : [];
    if (rawSteps.length === 0) return { ok: false, error: 'steps 至少需要一条' };
    const upgraded = upgradeV1Steps(rawSteps, ctx, warnings);
    if ('error' in upgraded) return { ok: false, error: upgraded.error };
    graph = upgraded;
  } else {
    const rawNodes = Array.isArray(job.nodes) ? job.nodes : [];
    if (rawNodes.length === 0) return { ok: false, error: 'nodes 至少需要一个' };
    const parsedNodes = parseNodes(rawNodes, ctx, warnings);
    if ('error' in parsedNodes) return { ok: false, error: parsedNodes.error };
    const rawEdges = Array.isArray(job.edges) ? job.edges : [];
    const parsedEdges = parseEdges(rawEdges, parsedNodes.nodes, warnings);
    if ('error' in parsedEdges) return { ok: false, error: parsedEdges.error };
    graph = { nodes: parsedNodes.nodes, edges: parsedEdges.edges };
  }

  const sch = (
    typeof job.schedule === 'object' && job.schedule !== null ? job.schedule : {}
  ) as Record<string, unknown>;
  let enabled = false;
  let freqType: FreqType | null = null;
  let cronExpr: string | null = null;
  let timezone = ctx.defaultTimezone;
  if (sch.enabled === true) {
    const ft = isFreqType(sch.freqType) ? sch.freqType : null;
    const ce = str(sch.cronExpr) ?? null;
    if (!ft || !ce) return { ok: false, error: '调度配置无效：缺少 freqType 或 cronExpr' };
    timezone = str(sch.timezone) ?? ctx.defaultTimezone;
    if (!validateCron(ce, timezone)) return { ok: false, error: 'cron 表达式或时区无效' };
    enabled = true;
    freqType = ft;
    cronExpr = ce;
  }

  const name = uniqueName(rawName, ctx.takenNames);
  if (name !== rawName) warnings.push(`已存在同名 Job，本次导入为「${name}」`);
  ctx.takenNames.add(name);

  return {
    ok: true,
    data: {
      name,
      description: str(job.description) ?? null,
      enabled,
      freqType,
      cronExpr,
      timezone,
      nodes: graph.nodes,
      edges: graph.edges,
      warnings,
    },
  };
}
