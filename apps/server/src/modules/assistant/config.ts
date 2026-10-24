import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import type { SettingsRepo } from '../settings/repo.js';
import {
  ASSISTANT_KEYS,
  DEFAULT_ASSISTANT_API_BASE,
  DEFAULT_ASSISTANT_MODEL,
} from '../settings/routes.js';

export interface AssistantConfig {
  apiBase: string;
  model: string;
  /** 未配置或解密失败时为 null */
  apiKey: string | null;
}

/** 读取 AI 智能体配置：DB 覆盖优先，API Key 解密后使用。 */
export function readAssistantConfig(config: AppConfig, settings: SettingsRepo): AssistantConfig {
  const apiBase = settings.get(ASSISTANT_KEYS.apiBase) ?? DEFAULT_ASSISTANT_API_BASE;
  const model = settings.get(ASSISTANT_KEYS.model) ?? DEFAULT_ASSISTANT_MODEL;
  const encrypted = settings.get(ASSISTANT_KEYS.apiKeyEnc);
  let apiKey: string | null = null;
  if (encrypted) {
    try {
      const plain = decryptConfig(encrypted, config.encryptionKey);
      if (typeof plain.apiKey === 'string' && plain.apiKey.trim()) apiKey = plain.apiKey.trim();
    } catch {
      /* 密钥无法解密时按未配置处理，用户可在设置页重新填写 */
    }
  }
  return { apiBase, model, apiKey };
}
