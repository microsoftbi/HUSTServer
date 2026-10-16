import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from 'better-sqlite3';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { parseWorkflowPayload, WorkflowParseError } from './parse.js';
import { decryptConfig, encryptConfig, maskConnection } from '../connections/crypto.js';
import { testTcp } from '../connections/probe.js';
import {
  pathMappingsRepo,
  workflowConnectionsRepo,
  workflowFilesRepo,
  workflowsRepo,
  type PathMappingInput,
  type WorkflowRow,
} from './repo.js';
import { storeUpload } from './storage.js';

const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;
const MAX_DATA_BYTES = 200 * 1024 * 1024;

/** SQL Server 节点类型（其连接配置可按工作流私有编辑）。 */
const SQL_NODE_KINDS = ['inputSqlServer', 'outputSqlServer'] as const;
const isSqlNode = (kind: string): boolean => (SQL_NODE_KINDS as readonly string[]).includes(kind);

export interface WorkflowRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

function stripEmbeddedConnections(workflow: { nodes: Array<Record<string, unknown>> }) {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => {
      const config = { ...(n.config as Record<string, unknown> | undefined) };
      if (config.connection !== undefined) delete config.connection;
      return { ...n, config };
    }),
  };
}

/** 合并新旧连接配置：密码留空（或未提供）表示沿用原值。 */
function mergeConnectionConfig(prev: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev, ...incoming };
  if (!incoming.password) {
    if (prev.password !== undefined) next.password = prev.password;
    else delete next.password;
  }
  return next;
}

/** 抽取 SQL Server 节点内嵌的连接配置（用于创建时留存为工作流私有默认值）。 */
function extractEmbeddedConnections(workflow: { nodes: Array<Record<string, unknown>> }): Array<{ nodeId: string; config: Record<string, unknown> }> {
  const out: Array<{ nodeId: string; config: Record<string, unknown> }> = [];
  for (const node of workflow.nodes) {
    if (!isSqlNode(String(node.kind))) continue;
    const conn = (node.config as Record<string, unknown> | undefined)?.connection;
    if (conn && typeof conn === 'object' && typeof node.id === 'string') {
      out.push({ nodeId: node.id, config: conn as Record<string, unknown> });
    }
  }
  return out;
}

export function workflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const workflows = workflowsRepo(deps.db);
  const files = workflowFilesRepo(deps.db);
  const mappings = pathMappingsRepo(deps.db);
  const wfConnections = workflowConnectionsRepo(deps.db);

  const canAccess = (req: FastifyRequest, wf: WorkflowRow): boolean =>
    req.auth!.caps.has('admin') || wf.owner_id === req.auth!.userId;

  async function loadChecked(req: FastifyRequest, reply: FastifyReply): Promise<WorkflowRow | null> {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) {
      await reply.code(404).send({ error: '工作流不存在' });
      return null;
    }
    if (!canAccess(req, wf)) {
      await reply.code(403).send({ error: '无权访问该工作流' });
      return null;
    }
    return wf;
  }

  app.post('/api/workflows/upload', { preHandler: auth }, async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: '缺少上传文件' });
    const buf = await part.toBuffer();
    if (buf.byteLength > MAX_WORKFLOW_BYTES) return reply.code(413).send({ error: '工作流文件过大' });
    try {
      const parsed = parseWorkflowPayload(buf.toString('utf8'));
      // 保留内嵌连接一并返回：前端会原样回传给创建接口，用于留存为工作流私有默认配置。
      return {
        name: parsed.workflow.name,
        workflow: parsed.workflow,
        inputs: parsed.inputs,
        outputs: parsed.outputs,
      };
    } catch (err) {
      if (err instanceof WorkflowParseError) return reply.code(400).send({ error: err.message, detail: err.detail });
      throw err;
    }
  });

  app.post('/api/workflows', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; workflow?: unknown; mappings?: Array<PathMappingInput> };
    let parsed;
    try {
      parsed = parseWorkflowPayload(JSON.stringify(body.workflow ?? {}));
    } catch (err) {
      if (err instanceof WorkflowParseError) return reply.code(400).send({ error: err.message, detail: err.detail });
      throw err;
    }
    const stripped = stripEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> });
    const payload = JSON.stringify({ nodes: stripped.nodes, edges: parsed.workflow.edges });
    const wf = workflows.create({
      ownerId: req.auth!.userId,
      name: body.name?.trim() || parsed.workflow.name,
      payload,
    });
    // 留存 .htyx 内嵌的 SQL Server 连接作为该工作流私有默认配置（明文不落 payload）。
    for (const { nodeId, config } of extractEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> })) {
      wfConnections.upsert({ workflowId: wf.id, nodeId, configEncrypted: encryptConfig(config, deps.config.encryptionKey) });
    }
    if (Array.isArray(body.mappings) && body.mappings.length) {
      mappings.replaceForWorkflow(wf.id, body.mappings.map((m) => ({ ...m, workflow_id: wf.id })));
    }
    return reply.code(201).send({ id: wf.id, name: wf.name });
  });

  app.get('/api/workflows', { preHandler: auth }, async (req) => {
    const rows = req.auth!.caps.has('admin') ? workflows.listAll() : workflows.listForOwner(req.auth!.userId);
    return rows.map((w) => ({ id: w.id, name: w.name, owner_id: w.owner_id, updated_at: w.updated_at }));
  });

  app.get('/api/workflows/:id', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    return {
      id: wf.id, name: wf.name, owner_id: wf.owner_id,
      workflow: JSON.parse(wf.payload),
      files: files.listByWorkflow(wf.id),
      mappings: mappings.listByWorkflow(wf.id),
      updated_at: wf.updated_at,
    };
  });

  app.put('/api/workflows/:id', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const body = (req.body ?? {}) as { name?: string; workflow?: unknown };
    let parsed;
    try {
      parsed = parseWorkflowPayload(JSON.stringify(body.workflow ?? {}));
    } catch (err) {
      if (err instanceof WorkflowParseError) return reply.code(400).send({ error: err.message, detail: err.detail });
      throw err;
    }
    const stripped = stripEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> });
    const payload = JSON.stringify({ nodes: stripped.nodes, edges: parsed.workflow.edges });
    const name = body.name?.trim() || parsed.workflow.name || wf.name;
    const updated = workflows.update(wf.id, { name, payload });
    // 与 POST 同样留存画布内嵌的 SQL Server 连接；区别在于 PUT 面向既有工作流，
    // 需先与库中原配置合并（密码留空=沿用原值），掩码密码视同留空，避免覆盖真实密码。
    // PUT 为「保存并发布=全量覆盖 payload」语义：同一事务内先 upsert 本次提取的连接，
    // 再对账删除不在本次集合中的行——清理已删节点遗留的孤儿行，防止同 id 新节点复活旧配置。
    const extracted = extractEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> });
    const persistConnections = deps.db.transaction(() => {
      for (const { nodeId, config } of extracted) {
        const incoming = { ...config };
        if (incoming.password === '******') incoming.password = '';
        const existing = wfConnections.findByNode(wf.id, nodeId);
        const prev = existing ? decryptConfig(existing.config_encrypted, deps.config.encryptionKey) : {};
        const next = mergeConnectionConfig(prev, incoming);
        wfConnections.upsert({ workflowId: wf.id, nodeId, configEncrypted: encryptConfig(next, deps.config.encryptionKey) });
      }
      wfConnections.delNotIn(wf.id, extracted.map((e) => e.nodeId));
    });
    persistConnections();
    return { ok: true, id: updated!.id, name: updated!.name };
  });

  app.delete('/api/workflows/:id', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    workflows.remove(wf.id);
    return { ok: true };
  });

  app.put('/api/workflows/:id/mappings', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const { mappings: items } = (req.body ?? {}) as { mappings?: Array<PathMappingInput> };
    if (!Array.isArray(items)) return reply.code(400).send({ error: 'mappings 必须为数组' });
    mappings.replaceForWorkflow(wf.id, items.map((m) => ({ ...m, workflow_id: wf.id })));
    return { ok: true, mappings: mappings.listByWorkflow(wf.id) };
  });

  // 工作流数据连接：列出该工作流内的 SQL Server 节点及其连接配置（密码掩码）。
  app.get('/api/workflows/:id/connections', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const workflow = JSON.parse(wf.payload) as { nodes?: Array<Record<string, unknown>> };
    const sqlNodes = (workflow.nodes ?? []).filter((n) => isSqlNode(String(n.kind)));
    return {
      nodes: sqlNodes.map((n) => {
        const nodeId = String(n.id);
        const row = wfConnections.findByNode(wf.id, nodeId);
        return {
          node_id: nodeId,
          kind: String(n.kind),
          name: typeof n.name === 'string' ? n.name : null,
          config: row ? maskConnection(decryptConfig(row.config_encrypted, deps.config.encryptionKey)) : null,
        };
      }),
    };
  });

  // 编辑某个 SQL Server 节点的连接配置。密码留空表示沿用原值。
  app.put('/api/workflows/:id/connections/:nodeId', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const { nodeId } = req.params as { id: string; nodeId: string };
    const workflow = JSON.parse(wf.payload) as { nodes?: Array<Record<string, unknown>> };
    const node = (workflow.nodes ?? []).find((n) => String(n.id) === nodeId);
    if (!node || !isSqlNode(String(node.kind))) {
      return reply.code(400).send({ error: '该节点不存在或不是 SQL Server 节点' });
    }
    const body = (req.body ?? {}) as { config?: Record<string, unknown> };
    if (!body.config || typeof body.config !== 'object') return reply.code(400).send({ error: '缺少连接配置' });

    const existing = wfConnections.findByNode(wf.id, nodeId);
    const prev = existing ? decryptConfig(existing.config_encrypted, deps.config.encryptionKey) : {};
    const next = mergeConnectionConfig(prev, body.config);
    wfConnections.upsert({ workflowId: wf.id, nodeId, configEncrypted: encryptConfig(next, deps.config.encryptionKey) });
    return { ok: true, node_id: nodeId, config: maskConnection(next) };
  });

  // 测试连接：用当前表单配置（密码留空则沿用原值）做一次 TCP 连通性探测。
  app.post('/api/workflows/:id/connections/:nodeId/test', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const { nodeId } = req.params as { id: string; nodeId: string };
    const workflow = JSON.parse(wf.payload) as { nodes?: Array<Record<string, unknown>> };
    const node = (workflow.nodes ?? []).find((n) => String(n.id) === nodeId);
    if (!node || !isSqlNode(String(node.kind))) {
      return reply.code(400).send({ error: '该节点不存在或不是 SQL Server 节点' });
    }
    const body = (req.body ?? {}) as { config?: Record<string, unknown> };
    const existing = wfConnections.findByNode(wf.id, nodeId);
    const prev = existing ? decryptConfig(existing.config_encrypted, deps.config.encryptionKey) : {};
    const cfg = mergeConnectionConfig(prev, body.config ?? {});
    const server = String(cfg.server ?? '');
    if (!server) return reply.code(400).send({ error: '连接缺少 server' });
    return testTcp(server, Number(cfg.port ?? 1433));
  });

  app.post('/api/workflows/:id/files', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: '缺少数据文件' });
    const nodeId = String((part.fields.nodeId as { value?: string } | undefined)?.value ?? '');
    if (!nodeId) return reply.code(400).send({ error: '缺少 nodeId 字段' });
    const buf = await part.toBuffer();
    if (buf.byteLength > MAX_DATA_BYTES) return reply.code(413).send({ error: '数据文件过大' });

    const uploaded = storeUpload(deps.config.uploadDir, part.filename || 'data.csv', buf);
    const dir = `${wf.id}`;
    const { mkdirSync, renameSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(deps.config.uploadDir, dir), { recursive: true });
    renameSync(join(deps.config.uploadDir, uploaded.storedName), join(deps.config.uploadDir, dir, uploaded.storedName));

    const existing = files.findByNode(wf.id, nodeId);
    const originalRef = existing?.original_ref ?? part.filename ?? 'data.csv';
    const write = deps.db.transaction(() => {
      if (existing) files.remove(existing.id);
      const added = files.add({
        workflowId: wf.id, nodeId,
        originalRef, storedName: uploaded.storedName, size: uploaded.size,
      });
      const current = mappings.listByWorkflow(wf.id).filter((m) => !(m.direction === 'input' && m.node_id === nodeId));
      current.push({
        id: '', workflow_id: wf.id, node_id: nodeId, direction: 'input',
        original_ref: originalRef, target_type: 'uploaded_file', target_ref: uploaded.storedName,
      });
      mappings.replaceForWorkflow(wf.id, current.map(({ id: _id, ...rest }) => rest));
      return added;
    });
    const row = write();

    return reply.code(201).send({ id: row.id, stored_name: row.stored_name, size: row.size, original_ref: row.original_ref });
  });

  app.get('/api/workflows/:id/files', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    return files.listByWorkflow(wf.id);
  });
}
