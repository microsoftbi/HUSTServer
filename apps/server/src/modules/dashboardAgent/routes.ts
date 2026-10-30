import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ColumnInfo } from '@hustserver/engine';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { AuditRecorder } from '../audit/repo.js';
import { readAssistantConfig } from '../assistant/config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { mergeColumnTypes, parseColumnTypeConfig } from '../models/columnTypes.js';
import { dataModelsRepo, modelColumnConfigsRepo } from '../models/repo.js';
import type { SettingsRepo } from '../settings/repo.js';
import type { UsersRepo } from '../users/repo.js';
import { createDashboardAgentService, type AgentAnswer } from './service.js';
import { normalizeSlots, specWidgetCount, type AgentModel } from './schema.js';

/** 单次需求描述的字符数上限 */
const MAX_PROMPT_LENGTH = 4000;

export interface DashboardAgentRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  settings: SettingsRepo;
  audit: AuditRecorder;
}

/**
 * 仪表板智能体：自然语言 → 逐项确认 → 仪表板规格。
 * plan 只解析槽位与出题；generate 输出语义结构，坐标与尺寸由前端生成。
 */
export function dashboardAgentRoutes(app: FastifyInstance, deps: DashboardAgentRoutesDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = dataModelsRepo(deps.db);
  const columnConfigs = modelColumnConfigsRepo(deps.db);
  const service = createDashboardAgentService();

  /** 可见模型：管理员看全部，其他人看自己的与无归属的公共模型 */
  const visibleModels = (isAdmin: boolean, userId: string): AgentModel[] =>
    repo
      .list()
      .filter((row) => isAdmin || row.owner_id === userId || row.owner_id === null)
      .map((row) => {
        const overrides = parseColumnTypeConfig(columnConfigs.get(row.name)?.columns ?? null);
        return {
          name: row.name,
          rowCount: row.row_count,
          ownerId: row.owner_id,
          columns: mergeColumnTypes(JSON.parse(row.columns) as ColumnInfo[], overrides),
        };
      });

  const modelsOf = (req: FastifyRequest): AgentModel[] =>
    visibleModels(req.auth!.caps.has('admin'), req.auth!.userId);

  app.get(
    '/api/dashboard-agent/models',
    { preHandler: [auth, requireCap('dashboard.view')] },
    async (req) => ({
      items: modelsOf(req).map((m) => ({
        name: m.name,
        rowCount: m.rowCount,
        columns: m.columns,
      })),
    }),
  );

  app.post(
    '/api/dashboard-agent/plan',
    { preHandler: [auth, requireCap('dashboard.edit')] },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        prompt?: unknown;
        slots?: unknown;
        answer?: unknown;
        history?: unknown;
      };
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return reply.code(400).send({ error: '请输入需求描述' });
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return reply.code(400).send({ error: `需求描述过长（最多 ${MAX_PROMPT_LENGTH} 字）` });
      }

      const models = modelsOf(req);
      if (models.length === 0) {
        return reply.code(400).send({ error: '还没有可用的数据模型，请先加载数据模型' });
      }

      const answer = body.answer as AgentAnswer | undefined;
      const history = Array.isArray(body.history)
        ? (body.history as Array<{ role: 'user' | 'assistant'; content: string }>)
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map((m) => ({ role: m.role, content: m.content }))
        : [];

      try {
        return await service.plan({
          prompt,
          slots: body.slots,
          ...(answer && typeof answer === 'object' ? { answer: answer as AgentAnswer } : {}),
          history,
          models,
          cfg: readAssistantConfig(deps.config, deps.settings),
        });
      } catch (err) {
        return reply.code(502).send({
          error: '解析需求失败',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    '/api/dashboard-agent/generate',
    { preHandler: [auth, requireCap('dashboard.edit')] },
    async (req, reply) => {
      const body = (req.body ?? {}) as { prompt?: unknown; slots?: unknown };
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return reply.code(400).send({ error: '请输入需求描述' });

      const slots = normalizeSlots(body.slots);
      if (!slots.model) return reply.code(400).send({ error: '请先选择要连接的数据模型' });

      const models = modelsOf(req);
      if (!models.some((m) => m.name === slots.model)) {
        return reply.code(400).send({ error: `数据模型「${slots.model}」不存在或无权访问` });
      }

      try {
        const result = await service.generate({
          prompt,
          slots,
          models,
          cfg: readAssistantConfig(deps.config, deps.settings),
        });
        deps.audit.record({
          userId: req.auth!.userId,
          action: 'other',
          resource: 'dashboard',
          resourceName: result.spec.name,
          description: `AI 生成仪表板「${result.spec.name}」（${specWidgetCount(result.spec)} 个视觉对象，来源：${
            result.source === 'llm' ? '大模型' : '本地模板'
          }）`,
        });
        return result;
      } catch (err) {
        return reply.code(502).send({
          error: '生成仪表板失败',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
