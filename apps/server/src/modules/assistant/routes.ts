import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { dataModelsRepo, modelLabelsRepo } from '../models/repo.js';
import type { ModelStore } from '../models/service.js';
import type { SettingsRepo } from '../settings/repo.js';
import type { UsersRepo } from '../users/repo.js';
import { readAssistantConfig } from './config.js';
import { assistantRepo } from './repo.js';
import { createAssistantService, toMessageView } from './service.js';

const MAX_QUESTION_LENGTH = 4000;

export interface AssistantRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  settings: SettingsRepo;
  modelStore: ModelStore;
}

/**
 * AI 智能体：自然语言 → DuckDB 只读 SQL → 结果。
 * 会话按用户隔离，入口能力与数据探索一致（connection.use）。
 */
export function assistantRoutes(app: FastifyInstance, deps: AssistantRoutesDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const guard = [auth, requireCap('connection.use')];
  const repo = assistantRepo(deps.db);
  const models = dataModelsRepo(deps.db);
  const modelLabels = modelLabelsRepo(deps.db);
  const service = createAssistantService({
    modelStore: deps.modelStore,
    models,
    labels: modelLabels,
    repo,
  });

  app.get('/api/assistant/status', { preHandler: guard }, async () => {
    const cfg = readAssistantConfig(deps.config, deps.settings);
    return { configured: Boolean(cfg.apiKey), apiBase: cfg.apiBase, model: cfg.model };
  });

  app.get('/api/assistant/conversations', { preHandler: guard }, async (req) => ({
    items: repo.listConversations(req.auth!.userId).map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      compressed: (row.compressed_until_seq ?? 0) > 0,
    })),
  }));

  /** 会话体量统计：前端小按钮的悬停提示使用。 */
  app.get('/api/assistant/conversations/:id/stats', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return service.stats({ userId: req.auth!.userId, conversationId: id });
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : '会话不存在' });
    }
  });

  /** 压缩历史对话：用大模型生成摘要，覆盖压缩点之前的消息。 */
  app.post('/api/assistant/conversations/:id/compress', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = repo.findConversation(id, req.auth!.userId);
    if (!conversation) return reply.code(404).send({ error: '会话不存在' });
    const rows = repo.listAllMessages(id);
    if (rows.length === 0) return reply.code(400).send({ error: '会话还没有消息，无需压缩' });
    const baseSeq = conversation.compressed_until_seq ?? 0;
    if (rows.filter((row) => row.seq > baseSeq).length === 0) {
      return reply.code(400).send({ error: '没有新的消息可压缩' });
    }
    const cfg = readAssistantConfig(deps.config, deps.settings);
    if (!cfg.apiKey) {
      return reply
        .code(400)
        .send({ error: 'assistant_not_configured', detail: '请先在「设置 → AI 智能体」中配置 API Key' });
    }
    try {
      return await service.compress({ userId: req.auth!.userId, conversationId: id, cfg });
    } catch (err) {
      return reply.code(502).send({
        error: '压缩失败',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/assistant/conversations/:id/messages', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = repo.findConversation(id, req.auth!.userId);
    if (!conversation) return reply.code(404).send({ error: '会话不存在' });
    return { items: repo.listMessages(id, 200).map(toMessageView) };
  });

  app.delete('/api/assistant/conversations/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.deleteConversation(id, req.auth!.userId)) {
      return reply.code(404).send({ error: '会话不存在' });
    }
    return reply.code(204).send();
  });

  app.post('/api/assistant/chat', { preHandler: guard }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      conversationId?: string;
      question?: string;
      modelName?: string;
    };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return reply.code(400).send({ error: '请输入问题' });
    if (question.length > MAX_QUESTION_LENGTH) {
      return reply.code(400).send({ error: `问题过长（最多 ${MAX_QUESTION_LENGTH} 字）` });
    }
    const modelName =
      typeof body.modelName === 'string' && body.modelName.trim() ? body.modelName.trim() : null;
    if (modelName && !models.findByName(modelName)) {
      return reply.code(400).send({ error: '指定的数据模型不存在' });
    }

    const cfg = readAssistantConfig(deps.config, deps.settings);
    if (!cfg.apiKey) {
      return reply
        .code(400)
        .send({ error: 'assistant_not_configured', detail: '请先在「设置 → AI 智能体」中配置 API Key' });
    }

    try {
      const result = await service.chat({
        userId: req.auth!.userId,
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        ...(modelName ? { modelName } : {}),
        question,
        cfg,
      });
      return result;
    } catch (err) {
      return reply.code(502).send({
        error: '大模型调用失败',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
