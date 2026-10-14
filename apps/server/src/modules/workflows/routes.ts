import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from 'better-sqlite3';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { parseWorkflowPayload, WorkflowParseError } from './parse.js';
import { pathMappingsRepo, workflowFilesRepo, workflowsRepo, type PathMappingInput, type WorkflowRow } from './repo.js';
import { storeUpload } from './storage.js';

const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;
const MAX_DATA_BYTES = 200 * 1024 * 1024;

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

export function workflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const workflows = workflowsRepo(deps.db);
  const files = workflowFilesRepo(deps.db);
  const mappings = pathMappingsRepo(deps.db);

  const canAccess = (req: FastifyRequest, wf: WorkflowRow): boolean =>
    req.auth!.role === 'admin' || wf.owner_id === req.auth!.userId;

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
      return {
        name: parsed.workflow.name,
        workflow: stripEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> }),
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
    if (Array.isArray(body.mappings) && body.mappings.length) {
      mappings.replaceForWorkflow(wf.id, body.mappings.map((m) => ({ ...m, workflow_id: wf.id })));
    }
    return reply.code(201).send({ id: wf.id, name: wf.name });
  });

  app.get('/api/workflows', { preHandler: auth }, async (req) => {
    const rows = req.auth!.role === 'admin' ? workflows.listAll() : workflows.listForOwner(req.auth!.userId);
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
