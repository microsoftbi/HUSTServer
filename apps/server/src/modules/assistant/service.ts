import type { QueryResult } from '../data/query.js';
import { checkReadOnly } from '../explore/sqlGuard.js';
import type { DataModelRow, DataModelsRepo, ModelLabelsRepo } from '../models/repo.js';
import type { ModelStore } from '../models/service.js';
import type { AssistantConfig } from './config.js';
import type { AssistantConversationRow, AssistantMessageRow, AssistantRepo } from './repo.js';

/** 聊天中返回给前端的行数上限（与分析场景一致，避免单次结果过大）。 */
const RESULT_LIMIT = 200;
/** 携带的历史消息条数（含本轮提问），用于多轮上下文。 */
const HISTORY_LIMIT = 12;
/** 生成失败后带错误信息回灌重试的次数上限（含首次）。 */
const MAX_ATTEMPTS = 2;
const LLM_TIMEOUT_MS = 60_000;
/** 压缩摘要的目标字数上限（写入提示词，模型未必严格遵守）。 */
const SUMMARY_MAX_CHARS = 800;
/** 压缩时单条消息进入摘要提示词的最大字符数。 */
const TRANSCRIPT_MESSAGE_MAX = 400;

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LlmPlan {
  sql: string | null;
  answer: string;
  needsClarification: string;
}

export interface AssistantMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql: string | null;
  result: QueryResult | null;
  createdAt: number;
}

export interface AssistantChatInput {
  userId: string;
  conversationId?: string;
  question: string;
  /** 指定数据模型：问题只针对该模型（不传则可在全部模型中查询）。 */
  modelName?: string;
  cfg: AssistantConfig;
}

/** 一轮模型调用的调试快照：实际下发的消息与模型返回。 */
export interface AssistantDebugRound {
  attempt: number;
  /** 本次调用下发给模型的消息（含系统提示词、摘要、历史与重试追加内容） */
  messages: ChatCompletionMessage[];
  /** 模型原始返回，调用失败时为空 */
  response?: string;
  /** 本轮解析或执行产生的错误 */
  error?: string;
}

/** 最近一次问答的调试信息，用于人工核对提示词与上下文。 */
export interface AssistantDebug {
  model: string;
  apiBase: string;
  rounds: AssistantDebugRound[];
  sql: string | null;
  answer: string;
  error: string | null;
}

export interface AssistantChatResult {
  conversationId: string;
  message: AssistantMessageView;
  debug: AssistantDebug;
}

export interface AssistantCompressInput {
  userId: string;
  conversationId: string;
  cfg: AssistantConfig;
}

/** 会话体量统计：字节数均按 UTF-8 计算。 */
export interface AssistantStats {
  messageCount: number;
  /** 全部消息（含 SQL）的总字节数 */
  totalBytes: number;
  /** 实际下发给大模型的上下文字节数（摘要 + 压缩点之后的历史） */
  contextBytes: number;
  /** 压缩点之后尚未压缩的消息条数 */
  uncompressedMessages: number;
  summaryBytes: number;
  compressedUntilSeq: number;
  compressed: boolean;
}

export interface AssistantCompressResult {
  conversationId: string;
  summary: string;
  compressedUntilSeq: number;
  /** 本次被摘要覆盖的消息条数 */
  compressedMessages: number;
  stats: AssistantStats;
}

export interface AssistantService {
  chat(input: AssistantChatInput): Promise<AssistantChatResult>;
  compress(input: AssistantCompressInput): Promise<AssistantCompressResult>;
  stats(input: { userId: string; conversationId: string }): AssistantStats;
}

/** 把数据库中的消息行转换为前端视图（解析结果是防御式的，损坏时按无结果处理）。 */
export function toMessageView(row: AssistantMessageRow): AssistantMessageView {
  let result: QueryResult | null = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json) as QueryResult;
    } catch {
      result = null;
    }
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sql: row.sql,
    result,
    createdAt: row.created_at,
  };
}

/** 去掉 SQL 注释与单引号字面量，保留双引号标识符，便于扫描表名。 */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 提取 FROM / JOIN 后引用的表名（跳过子查询与表函数）。 */
function referencedTables(sql: string): string[] {
  const cleaned = stripCommentsAndStrings(sql);
  const re = /\b(?:from|join)\s+("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/gi;
  const names: string[] = [];
  for (const match of cleaned.matchAll(re)) {
    const token = match[1];
    const end = (match.index ?? 0) + match[0].length;
    if (cleaned[end] === '(') continue; // 表函数，例如 read_parquet(...)
    const name = match[2] ?? token.split('.').pop() ?? token;
    names.push(name.replace(/["`]/g, ''));
  }
  return names;
}

function assertKnownTables(sql: string, known: Set<string>): void {
  const unknown = referencedTables(sql).find((name) => !known.has(name.toLowerCase()));
  if (unknown) throw new Error(`SQL 引用了不存在的数据表：${unknown}`);
}

function buildSystemPrompt(models: DataModelRow[], labelText: string): string {
  if (models.length === 0) {
    return [
      '你是本系统的数据分析助手，负责把用户的问题翻译成 DuckDB SQL。',
      '当前系统里还没有任何数据模型，无法查询数据。',
      '请直接说明无法查询，并在 needsClarification 中提示用户先加载或生成数据模型。',
      '只输出 JSON：{"sql": "", "answer": "", "needsClarification": "..."}',
    ].join('\n');
  }

  const tables = models.map((model) => {
    let columns: Array<{ name: string; type: string }> = [];
    try {
      columns = JSON.parse(model.columns) as Array<{ name: string; type: string }>;
    } catch {
      /* 列信息损坏时按空列展示，模型仍可通过表名查询 */
    }
    const colText = columns.map((c) => `${c.name} ${c.type}`).join('、');
    return `- 表名 ${model.name}（约 ${model.row_count} 行）\n  列：${colText || '（未知）'}`;
  });

  return [
    '你是本系统的数据分析助手，负责把用户的自然语言问题翻译成 DuckDB SQL。',
    '当前可查询的数据表（表名即数据模型名，只能使用以下表）：',
    ...tables,
    ...(labelText
      ? ['', '该数据模型的业务说明（数据标签，帮助理解字段口径与业务含义）：', labelText]
      : []),
    '',
    '规则：',
    '1. 只能生成一条只读查询（SELECT 或 WITH），禁止写操作、DDL 或多条语句。',
    '2. 表名与列名必须来自上面的清单，不得臆造；表名含特殊字符时用双引号包裹。',
    '3. 聚合类查询请为结果列起中文别名；结果按需排序并用 LIMIT 控制行数。',
    '4. 除 JSON 外不要输出任何解释文字或代码块标记。',
    '5. 用户问题缺少必要信息（例如要查哪个时间段、哪个字段含义不明）时，在 needsClarification 里用一句话追问，并把 sql 留空。',
    '6. 用户后续追问可能依赖上文，请结合历史对话理解指代。',
    '',
    '输出 JSON 结构：',
    '{"sql": "查询语句", "answer": "对查询内容或结论的中文简述", "needsClarification": ""}',
  ].join('\n');
}

/** 压缩历史对话的提示词：要求保留分析目标、口径与结论，输出纯文本。 */
const COMPRESS_PROMPT = [
  '你是对话摘要助手。请把下面这段数据分析对话压缩成简洁的中文摘要，供后续问答继续使用。',
  '要求：',
  `1. 保留用户的分析目标、已确认的字段口径与业务含义、执行过的关键 SQL 的意图与结论；`,
  '2. 丢弃寒暄、重复表述与无关细节，不要虚构对话中没有的信息；',
  `3. 纯文本输出，不要 JSON、不要代码块，控制在 ${SUMMARY_MAX_CHARS} 字以内。`,
].join('\n');

/** UTF-8 字节数（用于统计会话体积）。 */
function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 单条消息的体积：正文 + SQL（查询结果不参与上下文，故不计入）。 */
function messageBytes(row: AssistantMessageRow): number {
  return bytesOf(row.content) + (row.sql ? bytesOf(row.sql) : 0);
}

/** 会话体量统计：上下文按「摘要 + 压缩点之后的历史」估算，与实际下发一致。 */
function conversationStats(conv: AssistantConversationRow, rows: AssistantMessageRow[]): AssistantStats {
  const summary = conv.summary?.trim() ?? '';
  const untilSeq = conv.compressed_until_seq ?? 0;
  const contextRows = rows.filter((row) => row.seq > untilSeq).slice(-HISTORY_LIMIT);
  return {
    messageCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + messageBytes(row), 0),
    contextBytes: bytesOf(summary) + contextRows.reduce((sum, row) => sum + messageBytes(row), 0),
    uncompressedMessages: rows.filter((row) => row.seq > untilSeq).length,
    summaryBytes: bytesOf(summary),
    compressedUntilSeq: untilSeq,
    compressed: untilSeq > 0,
  };
}

/** 组装压缩用的对话文本（截断超长消息，避免提示词过大）。 */
function buildTranscript(rows: AssistantMessageRow[]): string {
  const clip = (text: string): string =>
    text.length > TRANSCRIPT_MESSAGE_MAX ? `${text.slice(0, TRANSCRIPT_MESSAGE_MAX)}…` : text;
  return rows
    .map((row) => {
      if (row.role === 'user') return `用户：${clip(row.content)}`;
      const sql = row.sql ? `\n  SQL：${clip(row.sql)}` : '';
      return `助手：${clip(row.content)}${sql}`;
    })
    .join('\n\n');
}

function parsePlan(raw: string): LlmPlan {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型返回内容不是合法的 JSON');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('模型返回内容不是合法的 JSON');
  }
  const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    sql: asText(parsed.sql) || null,
    answer: asText(parsed.answer),
    needsClarification: asText(parsed.needsClarification),
  };
}

/** 调用 OpenAI 兼容的 /chat/completions（仪表板智能体复用同一套调用方式）。 */
export async function callLlm(cfg: AssistantConfig, messages: ChatCompletionMessage[]): Promise<string> {
  if (!cfg.apiKey) throw new Error('尚未配置 API Key');
  const url = `${cfg.apiBase.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0, stream: false }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`大模型接口返回 ${res.status}：${text.slice(0, 300)}`);
    }
    const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('大模型返回内容为空');
    return content;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('大模型调用超时');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createAssistantService(deps: {
  modelStore: ModelStore;
  models: DataModelsRepo;
  labels: ModelLabelsRepo;
  repo: AssistantRepo;
}): AssistantService {
  const { modelStore, models, labels, repo } = deps;

  return {
    async chat(input) {
      const question = input.question.trim();
      const allModels = models.list();
      // 指定模型时只向大模型暴露该模型，SQL 也只允许引用它
      const modelRows = input.modelName ? allModels.filter((m) => m.name === input.modelName) : allModels;
      const knownTables = new Set(modelRows.map((m) => m.name.toLowerCase()));
      const labelText = input.modelName ? labels.get(input.modelName)?.content.trim() ?? '' : '';

      const conversation =
        (input.conversationId ? repo.findConversation(input.conversationId, input.userId) : null) ??
        repo.createConversation(input.userId, question.slice(0, 30) || '新对话');

      repo.appendMessage({ conversationId: conversation.id, role: 'user', content: question });

      // 历史：压缩点之后的消息按时间顺序还原；更早的内容由摘要代替，便于追问与指代
      const summary = conversation.summary?.trim() ?? '';
      const history = repo.listMessagesAfter(
        conversation.id,
        conversation.compressed_until_seq ?? 0,
        HISTORY_LIMIT,
      );
      const messages: ChatCompletionMessage[] = [
        { role: 'system', content: buildSystemPrompt(modelRows, labelText) },
      ];
      if (summary) {
        messages.push({
          role: 'system',
          content: `以下是本会话较早对话的压缩摘要（用于理解上下文与指代，SQL 细节已省略）：\n${summary}`,
        });
      }
      for (const row of history) {
        if (row.role === 'assistant') {
          const content = row.sql ? `执行过的 SQL：\n${row.sql}\n\n回答：${row.content}` : row.content;
          messages.push({ role: 'assistant', content });
        } else {
          messages.push({ role: 'user', content: row.content });
        }
      }

      let answer = '';
      let sql: string | null = null;
      let result: QueryResult | null = null;
      let lastError: string | null = null;
      const rounds: AssistantDebugRound[] = [];

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const round: AssistantDebugRound = {
          attempt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        };
        rounds.push(round);
        const raw = await callLlm(input.cfg, messages);
        round.response = raw;

        let plan: LlmPlan;
        try {
          plan = parsePlan(raw);
        } catch (err) {
          lastError = (err as Error).message;
          round.error = lastError;
          if (attempt === MAX_ATTEMPTS) break;
          messages.push({ role: 'assistant', content: raw });
          messages.push({
            role: 'user',
            content: `${lastError}。请只输出符合要求的 JSON，不要包含任何多余文字。`,
          });
          continue;
        }

        if (plan.needsClarification) {
          answer = plan.needsClarification;
          sql = null;
          lastError = null;
          break;
        }

        if (!plan.sql) {
          lastError = '模型没有给出 SQL 语句';
          round.error = lastError;
          answer = plan.answer;
          if (attempt === MAX_ATTEMPTS) break;
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: '你没有给出 SQL，请直接输出包含 sql 字段的 JSON。' });
          continue;
        }

        sql = plan.sql;
        answer = plan.answer;
        try {
          const check = checkReadOnly(sql);
          if (!check.ok) throw new Error(check.reason ?? 'SQL 不是只读查询');
          assertKnownTables(sql, knownTables);
          result = await modelStore.rawQuery(sql, RESULT_LIMIT);
          lastError = null;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          round.error = lastError;
          result = null;
          if (attempt === MAX_ATTEMPTS) break;
          messages.push({ role: 'assistant', content: raw });
          messages.push({
            role: 'user',
            content: `上一条 SQL 执行失败：${lastError}。请据此修正后重新输出 JSON。`,
          });
        }
      }

      const content = lastError
        ? `未能完成查询：${lastError}`
        : answer || (result ? '查询完成。' : '请补充更多信息。');

      const persisted = repo.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content,
        sql,
        resultJson: result ? JSON.stringify(result) : null,
      });
      repo.touchConversation(conversation.id);

      return {
        conversationId: conversation.id,
        message: toMessageView(persisted),
        debug: {
          model: input.cfg.model,
          apiBase: input.cfg.apiBase,
          rounds,
          sql,
          answer,
          error: lastError,
        },
      };
    },

    async compress(input) {
      const conversation = repo.findConversation(input.conversationId, input.userId);
      if (!conversation) throw new Error('会话不存在');
      const baseSeq = conversation.compressed_until_seq ?? 0;
      // 增量压缩：只处理压缩点之后的新消息，已有摘要作为前置信息带入，避免信息丢失
      const rows = repo.listAllMessages(conversation.id).filter((row) => row.seq > baseSeq);
      if (rows.length === 0) {
        throw new Error(baseSeq > 0 ? '没有新的消息可压缩' : '会话还没有消息，无需压缩');
      }

      const prior = conversation.summary?.trim() ?? '';
      const transcript = `${prior ? `已有摘要：\n${prior}\n\n` : ''}${buildTranscript(rows)}`;
      const raw = await callLlm(input.cfg, [
        { role: 'system', content: COMPRESS_PROMPT },
        { role: 'user', content: transcript },
      ]);
      const summary = raw.trim();
      if (!summary) throw new Error('大模型返回的摘要为空');

      const untilSeq = rows[rows.length - 1]!.seq;
      repo.setSummary(conversation.id, summary, untilSeq);
      const updated = repo.findConversation(conversation.id, input.userId) ?? conversation;
      return {
        conversationId: conversation.id,
        summary,
        compressedUntilSeq: untilSeq,
        compressedMessages: rows.length,
        stats: conversationStats(updated, repo.listAllMessages(conversation.id)),
      };
    },

    stats(input) {
      const conversation = repo.findConversation(input.conversationId, input.userId);
      if (!conversation) throw new Error('会话不存在');
      return conversationStats(conversation, repo.listAllMessages(conversation.id));
    },
  };
}
