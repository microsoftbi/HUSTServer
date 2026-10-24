import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { UsersRepo } from '../users/repo.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { requireAuth, requireAdmin } from '../../plugins/guards.js';
import { encryptConfig } from '../connections/crypto.js';
import type { SettingsRepo } from './repo.js';

/** AI 智能体配置（API Key 只回传是否已配置，绝不回传明文）。 */
export interface AssistantSettingsView {
  apiBase: string;
  model: string;
  hasApiKey: boolean;
}

export interface AdminSettings {
  maxConcurrentRuns: number;
  logRetentionDays: number;
  sharedDirs: string[];
  tz: string;
  assistant: AssistantSettingsView;
}

export const DEFAULT_ASSISTANT_API_BASE = 'https://api.deepseek.com';
export const DEFAULT_ASSISTANT_MODEL = 'deepseek-chat';
/** settings 表中的键名 */
export const ASSISTANT_KEYS = {
  apiBase: 'assistant.apiBase',
  model: 'assistant.model',
  apiKeyEnc: 'assistant.apiKeyEnc',
} as const;

export interface SettingsRoutesDeps {
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  settings: SettingsRepo;
  /** 设置变更后回调（例如让调度器重读），可选 */
  onSettingsChanged?: () => void;
}

/** 合并 DB 覆盖与 config 默认值，得到对外暴露的系统设置视图。 */
export function readSettings(config: AppConfig, settings: SettingsRepo): AdminSettings {
  const raw = settings.all();
  const num = (key: string, fallback: number): number => {
    const v = raw[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  let sharedDirs = config.sharedDirs;
  if (raw.sharedDirs !== undefined) {
    try {
      const parsed = JSON.parse(raw.sharedDirs) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) sharedDirs = parsed;
    } catch {
      /* 保留默认 */
    }
  }
  return {
    maxConcurrentRuns: num('maxConcurrentRuns', config.maxConcurrentRuns),
    logRetentionDays: num('logRetentionDays', config.logRetentionDays),
    sharedDirs,
    tz: raw.tz ?? config.tz,
    assistant: {
      apiBase: raw[ASSISTANT_KEYS.apiBase] ?? DEFAULT_ASSISTANT_API_BASE,
      model: raw[ASSISTANT_KEYS.model] ?? DEFAULT_ASSISTANT_MODEL,
      hasApiKey: Boolean(raw[ASSISTANT_KEYS.apiKeyEnc]),
    },
  };
}

const POSITIVE_INT_KEYS = ['maxConcurrentRuns', 'logRetentionDays'] as const;

export function settingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.get('/api/admin/settings', { preHandler: [auth, requireAdmin] }, async () =>
    readSettings(deps.config, deps.settings),
  );

  app.put('/api/admin/settings', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, string> = {};

    for (const key of POSITIVE_INT_KEYS) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        return reply.code(400).send({ error: 'invalid_settings', detail: `${key} 必须为正整数` });
      }
      updates[key] = String(value);
    }

    if (body.sharedDirs !== undefined) {
      const dirs = body.sharedDirs;
      if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string' && d.length > 0)) {
        return reply.code(400).send({ error: 'invalid_settings', detail: 'sharedDirs 必须为非空字符串数组' });
      }
      updates.sharedDirs = JSON.stringify(dirs);
    }

    if (body.tz !== undefined) {
      if (typeof body.tz !== 'string' || body.tz.trim() === '') {
        return reply.code(400).send({ error: 'invalid_settings', detail: 'tz 必须为非空字符串' });
      }
      updates.tz = body.tz;
    }

    if (body.assistantApiBase !== undefined) {
      const value = body.assistantApiBase;
      if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value.trim())) {
        return reply
          .code(400)
          .send({ error: 'invalid_settings', detail: 'API 地址必须为 http:// 或 https:// 开头的 URL' });
      }
      updates[ASSISTANT_KEYS.apiBase] = value.trim().replace(/\/+$/, '');
    }

    if (body.assistantModel !== undefined) {
      const value = body.assistantModel;
      if (typeof value !== 'string' || value.trim() === '') {
        return reply.code(400).send({ error: 'invalid_settings', detail: '模型名称不能为空' });
      }
      updates[ASSISTANT_KEYS.model] = value.trim();
    }

    // 空字符串表示保持原有 Key 不变，避免前端留空提交时误清空凭据
    if (typeof body.assistantApiKey === 'string' && body.assistantApiKey.trim() !== '') {
      updates[ASSISTANT_KEYS.apiKeyEnc] = encryptConfig(
        { apiKey: body.assistantApiKey.trim() },
        deps.config.encryptionKey,
      );
    }

    if (Object.keys(updates).length > 0) {
      deps.settings.setMany(updates);
      deps.onSettingsChanged?.();
    }
    return readSettings(deps.config, deps.settings);
  });
}
