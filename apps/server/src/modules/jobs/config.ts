import fs from 'node:fs';
import type { ConnectionsRepo } from '../connections/repo.js';
import { MODEL_NAME_RE, type LoadModelConfig } from '../models/service.js';
import { isAllowedResourceFile, resolveResourcePath } from '../resources/paths.js';
import type { WorkflowsRepo } from '../workflows/repo.js';
import type { JobStepType } from './repo.js';

/** 请求体里「配置平铺」的节点字段（按类型取用）。 */
export interface NodeConfigInput {
  workflowId?: unknown;
  connectionId?: unknown;
  sql?: unknown;
  modelName?: unknown;
  source?: unknown;
  resourcePath?: unknown;
  format?: unknown;
  object?: unknown;
  query?: unknown;
}

export interface NodeConfigContext {
  resourceDir: string;
  isAdmin: boolean;
  userId: string;
  connections: ConnectionsRepo;
  workflows: WorkflowsRepo;
}

export type NodeConfigResult = { ok: true; config: string } | { ok: false; error: string };

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** 校验并归一化单个节点的配置，返回可落库的 JSON 字符串。 */
export function parseNodeConfig(
  type: JobStepType,
  raw: NodeConfigInput,
  ctx: NodeConfigContext,
): NodeConfigResult {
  if (type === 'workflow') {
    const workflowId = asString(raw.workflowId);
    const wf = workflowId ? ctx.workflows.findById(workflowId) : null;
    if (!wf || !(ctx.isAdmin || wf.owner_id === ctx.userId)) {
      return { ok: false, error: '工作流不可用' };
    }
    return { ok: true, config: JSON.stringify({ workflowId }) };
  }

  if (type === 'sql') {
    const connectionId = asString(raw.connectionId);
    const sqlText = asString(raw.sql);
    const conn = connectionId ? ctx.connections.findById(connectionId) : null;
    if (!conn || !(ctx.isAdmin || conn.shared === 1 || conn.owner_id === ctx.userId)) {
      return { ok: false, error: '连接不可用' };
    }
    if (!sqlText) return { ok: false, error: 'SQL 不能为空' };
    return { ok: true, config: JSON.stringify({ connectionId, sql: sqlText }) };
  }

  const modelName = asString(raw.modelName);
  if (!modelName || !MODEL_NAME_RE.test(modelName)) {
    return { ok: false, error: '模型名不合法' };
  }

  if (raw.source === 'file') {
    const resourcePath = asString(raw.resourcePath);
    if (!resourcePath) return { ok: false, error: '资源文件不可用' };
    let abs: string;
    try {
      abs = resolveResourcePath(ctx.resourceDir, resourcePath);
    } catch {
      return { ok: false, error: '资源文件不可用' };
    }
    if (!isAllowedResourceFile(abs) || !fs.existsSync(abs)) {
      return { ok: false, error: '资源文件不可用' };
    }
    const format = raw.format === 'csv' || raw.format === 'excel' ? raw.format : undefined;
    return {
      ok: true,
      config: JSON.stringify({
        source: 'file',
        modelName,
        resourcePath,
        ...(format ? { format } : {}),
      } satisfies LoadModelConfig),
    };
  }

  if (raw.source === 'sqlserver') {
    const connectionId = asString(raw.connectionId);
    const conn = connectionId ? ctx.connections.findById(connectionId) : null;
    if (!connectionId || !conn || !(ctx.isAdmin || conn.shared === 1 || conn.owner_id === ctx.userId)) {
      return { ok: false, error: '连接不可用' };
    }
    const object = asString(raw.object);
    const query = asString(raw.query);
    if (!object && !query) return { ok: false, error: '需要指定表或查询' };
    return {
      ok: true,
      config: JSON.stringify({
        source: 'sqlserver',
        modelName,
        connectionId,
        ...(object ? { object } : {}),
        ...(query ? { query } : {}),
      } satisfies LoadModelConfig),
    };
  }

  return { ok: false, error: '步骤来源无效' };
}
