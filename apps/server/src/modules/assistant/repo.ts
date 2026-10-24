import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type AssistantRole = 'user' | 'assistant';

export interface AssistantConversationRow {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  /** 已被摘要覆盖的最大消息 seq（0 表示从未压缩） */
  compressed_until_seq: number;
  created_at: number;
  updated_at: number;
}

export interface AssistantMessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: AssistantRole;
  content: string;
  sql: string | null;
  result_json: string | null;
  created_at: number;
}

export interface AppendMessageInput {
  conversationId: string;
  role: AssistantRole;
  content: string;
  sql?: string | null;
  resultJson?: string | null;
}

export interface AssistantRepo {
  listConversations(userId: string): AssistantConversationRow[];
  findConversation(id: string, userId: string): AssistantConversationRow | null;
  createConversation(userId: string, title: string): AssistantConversationRow;
  touchConversation(id: string): void;
  deleteConversation(id: string, userId: string): boolean;
  /** 按 seq 升序返回最近 limit 条消息 */
  listMessages(conversationId: string, limit?: number): AssistantMessageRow[];
  /** 按 seq 升序返回 seq 大于 afterSeq 的最近 limit 条消息 */
  listMessagesAfter(conversationId: string, afterSeq: number, limit?: number): AssistantMessageRow[];
  /** 按 seq 升序返回全部消息 */
  listAllMessages(conversationId: string): AssistantMessageRow[];
  /** 写入压缩摘要及其覆盖到的消息 seq */
  setSummary(id: string, summary: string, untilSeq: number): void;
  appendMessage(input: AppendMessageInput): AssistantMessageRow;
}

export function assistantRepo(db: Database): AssistantRepo {
  const listConv = db.prepare(
    'SELECT * FROM assistant_conversations WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC',
  );
  const findConv = db.prepare('SELECT * FROM assistant_conversations WHERE id = ? AND user_id = ?');
  const insertConv = db.prepare(
    'INSERT INTO assistant_conversations (id, user_id, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  );
  const touchConv = db.prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?');
  const delConv = db.prepare('DELETE FROM assistant_conversations WHERE id = ? AND user_id = ?');
  const recentMessages = db.prepare(
    `SELECT * FROM (
       SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?
     ) ORDER BY seq ASC`,
  );
  const nextSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM assistant_messages WHERE conversation_id = ?',
  );
  const afterMessages = db.prepare(
    `SELECT * FROM (
       SELECT * FROM assistant_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?
     ) ORDER BY seq ASC`,
  );
  const allMessages = db.prepare('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY seq ASC');
  const updateSummary = db.prepare(
    'UPDATE assistant_conversations SET summary = ?, compressed_until_seq = ?, updated_at = ? WHERE id = ?',
  );
  const insertMessage = db.prepare(
    'INSERT INTO assistant_messages (id, conversation_id, seq, role, content, sql, result_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const findMessage = db.prepare('SELECT * FROM assistant_messages WHERE id = ?');

  return {
    listConversations: (userId) => listConv.all(userId) as AssistantConversationRow[],
    findConversation: (id, userId) => (findConv.get(id, userId) as AssistantConversationRow | undefined) ?? null,
    createConversation(userId, title) {
      const id = nanoid();
      const now = Date.now();
      insertConv.run(id, userId, title, null, now, now);
      return findConv.get(id, userId) as AssistantConversationRow;
    },
    touchConversation: (id) => {
      touchConv.run(Date.now(), id);
    },
    deleteConversation: (id, userId) => delConv.run(id, userId).changes > 0,
    listMessages(conversationId, limit = 50) {
      const rows = recentMessages.all(conversationId, limit) as AssistantMessageRow[];
      return rows;
    },
    listMessagesAfter(conversationId, afterSeq, limit = 50) {
      return afterMessages.all(conversationId, afterSeq, limit) as AssistantMessageRow[];
    },
    listAllMessages: (conversationId) => allMessages.all(conversationId) as AssistantMessageRow[],
    setSummary: (id, summary, untilSeq) => {
      updateSummary.run(summary, untilSeq, Date.now(), id);
    },
    appendMessage(input) {
      const id = nanoid();
      const seq = (nextSeq.get(input.conversationId) as { seq: number }).seq;
      insertMessage.run(
        id,
        input.conversationId,
        seq,
        input.role,
        input.content,
        input.sql ?? null,
        input.resultJson ?? null,
        Date.now(),
      );
      return findMessage.get(id) as AssistantMessageRow;
    },
  };
}
