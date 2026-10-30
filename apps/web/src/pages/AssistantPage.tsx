import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Bug, Copy, Minimize2, Play, Plus, Ruler, Send, Trash2 } from 'lucide-react';
import { DataTable } from '@bi/components/DataTable';
import { api, ApiClientError } from '../api.js';
import { useAuth } from '../auth.js';
import { Button } from '../components/ui/button.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Modal } from '../components/ui/modal.js';
import { cn } from '../components/ui/utils.js';

interface QueryColumn {
  name: string;
  type: string;
}

interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Array<string | number | boolean | null>>;
  truncated: boolean;
}

interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql: string | null;
  result: QueryResult | null;
  createdAt: number;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface AssistantStatus {
  configured: boolean;
  apiBase: string;
  model: string;
}

interface ModelItem {
  name: string;
  rowCount: number;
}

interface ChatResponse {
  conversationId: string;
  message: AssistantMessage;
  debug: AssistantDebug;
}

/** 一轮模型调用的快照：实际下发的消息与模型返回。 */
interface AssistantDebugRound {
  attempt: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  response?: string;
  error?: string;
}

/** 最近一次问答的调试信息。 */
interface AssistantDebug {
  model: string;
  apiBase: string;
  rounds: AssistantDebugRound[];
  sql: string | null;
  answer: string;
  error: string | null;
}

/** 会话体量统计（字节数均按 UTF-8 计算） */
interface ConversationStats {
  messageCount: number;
  totalBytes: number;
  contextBytes: number;
  uncompressedMessages: number;
  summaryBytes: number;
  compressedUntilSeq: number;
  compressed: boolean;
}

interface CompressResult {
  conversationId: string;
  summary: string;
  compressedUntilSeq: number;
  compressedMessages: number;
  stats: ConversationStats;
}

/** 字节数转可读文本：小于 1 KB 时用 B，避免显示 0.0 KB。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 统一错误文案：优先展示服务端 detail（如额度不足、超时等具体原因）。 */
function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return err instanceof Error ? err.message : String(err);
}

export function AssistantPage() {
  const { hasCap } = useAuth();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  /** 最近一次问答实际下发给模型的完整内容，供调试弹窗查看 */
  const [debug, setDebug] = useState<AssistantDebug | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [compressing, setCompressing] = useState(false);
  /** 压缩结果在弹窗内展示，避免被遮罩挡住 */
  const [compressError, setCompressError] = useState<string | null>(null);
  const [compressNotice, setCompressNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api.get<{ items: Conversation[] }>('/api/assistant/conversations');
      setConversations(res.items);
      return res.items;
    } catch (err) {
      setError(errText(err));
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await api.get<{ items: AssistantMessage[] }>(
        `/api/assistant/conversations/${id}/messages`,
      );
      setMessages(res.items);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  const loadStats = useCallback(async (id: string | null) => {
    if (!id) {
      setStats(null);
      return;
    }
    try {
      setStats(await api.get<ConversationStats>(`/api/assistant/conversations/${id}/stats`));
    } catch {
      // 统计失败不影响主流程，悬停提示显示未知即可
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void api
      .get<AssistantStatus>('/api/assistant/status')
      .then(setStatus)
      .catch((err: unknown) => setError(errText(err)));
    void api
      .get<{ items: ModelItem[] }>('/api/models')
      .then((res) => setModels(res.items))
      .catch(() => undefined);
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? '新对话';

  /** 打开会话长度弹窗时刷新一次统计，保证数字是最新的 */
  function openStats(): void {
    setCompressError(null);
    setCompressNotice(null);
    setStatsOpen(true);
    void loadStats(activeId);
  }

  function selectConversation(id: string): void {
    setActiveId(id);
    setError(null);
    setNotice(null);
    setStatsOpen(false);
    void loadMessages(id);
    void loadStats(id);
  }

  function startNew(): void {
    setActiveId(null);
    setMessages([]);
    setInput('');
    setError(null);
    setNotice(null);
    setStats(null);
    setStatsOpen(false);
  }

  async function removeConversation(id: string): Promise<void> {
    if (!window.confirm('删除该对话及其全部消息？')) return;
    try {
      await api.del<void>(`/api/assistant/conversations/${id}`);
      if (activeId === id) startNew();
      await loadConversations();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function send(): Promise<void> {
    const question = input.trim();
    if (!question || sending) return;
    setInput('');
    setError(null);
    setSending(true);
    const tempId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        role: 'user',
        content: question,
        sql: null,
        result: null,
        createdAt: Date.now(),
      },
    ]);

    try {
      const res = await api.post<ChatResponse>('/api/assistant/chat', {
        body: {
          ...(activeId ? { conversationId: activeId } : {}),
          ...(selectedModel ? { modelName: selectedModel } : {}),
          question,
        },
      });
      setActiveId(res.conversationId);
      setMessages((prev) => [...prev.filter((m) => m.id !== tempId), res.message]);
      setDebug(res.debug);
      await loadConversations();
      void loadStats(res.conversationId);
    } catch (err) {
      setError(errText(err));
      // 服务端已落库时重新拉取，避免本地与服务端不一致
      if (activeId) await loadMessages(activeId);
      else setMessages((prev) => prev.filter((m) => m.id !== tempId));
    } finally {
      setSending(false);
    }
  }

  async function compressConversation(): Promise<void> {
    if (!activeId || compressing) return;
    setCompressing(true);
    setCompressError(null);
    setCompressNotice(null);
    try {
      const res = await api.post<CompressResult>(
        `/api/assistant/conversations/${activeId}/compress`,
      );
      setStats(res.stats);
      setCompressNotice(
        `已压缩 ${res.compressedMessages} 条历史消息，摘要 ${formatBytes(res.stats.summaryBytes)}；模型上下文 ${formatBytes(res.stats.contextBytes)}`,
      );
      await loadConversations();
    } catch (err) {
      setCompressError(errText(err));
    } finally {
      setCompressing(false);
    }
  }

  /** 把调试信息整体复制成 JSON，便于对照修改提示词 */
  function copyDebug(): void {
    if (!debug) return;
    void navigator.clipboard?.writeText(JSON.stringify(debug, null, 2)).catch(() => undefined);
  }

  async function rerunSql(messageId: string, sql: string): Promise<void> {
    try {
      const result = await api.post<QueryResult>('/api/explore/query', {
        body: { source: 'model', sql, limit: 200 },
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, result } : m)));
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] gap-4">
      <aside className="flex w-56 shrink-0 flex-col rounded-lg border border-border bg-background">
        <div className="border-b border-border p-3">
          <Button variant="outline" size="sm" className="w-full" onClick={startNew}>
            <Plus /> 新建对话
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">暂无历史对话。</p>
          ) : (
            <ul className="space-y-1">
              {conversations.map((c) => (
                <li key={c.id}>
                  <div
                    className={cn(
                      'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm',
                      c.id === activeId
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      title={c.title}
                      onClick={() => selectConversation(c.id)}
                    >
                      {c.title}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      title="删除对话"
                      onClick={() => void removeConversation(c.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-background">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-medium">{activeTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status && (
              <span className="text-xs text-muted-foreground">
                {status.model}
                {status.configured ? '' : '（未配置）'}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              title="查看最近一次发送给智能体的完整内容"
              onClick={() => setDebugOpen(true)}
            >
              <Bug /> 调试
            </Button>
          </div>
        </header>

        {status && !status.configured && (
          <div className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
            尚未配置大模型 API Key。
            {hasCap('admin') ? (
              <Link className="ml-1 text-primary underline-offset-2 hover:underline" to="/settings">
                前往设置页配置
              </Link>
            ) : (
              '请联系管理员在设置中配置。'
            )}
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Bot className="h-8 w-8 text-muted-foreground/60" />
              <p>用自然语言提问，助手会生成 SQL 并查询数据模型。</p>
              <p className="text-xs">例如：「统计最近 30 天每天的新建工单数」</p>
            </div>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[90%] space-y-2">
                  <div className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
                    {m.content}
                  </div>
                  {m.sql && <SqlCard sql={m.sql} onRerun={() => void rerunSql(m.id, m.sql!)} />}
                  {m.result && (
                    <div className="max-h-80 overflow-auto rounded-lg border border-border">
                      <DataTable columns={m.result.columns} rows={m.result.rows} pageSize={20} />
                      {m.result.truncated && (
                        <p className="px-3 py-1.5 text-xs text-muted-foreground">
                          结果已截断，仅显示前 200 行。
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}

          {sending && <p className="text-sm text-muted-foreground">正在生成查询…</p>}
          <div ref={bottomRef} />
        </div>

        <div className="shrink-0 space-y-2 border-t border-border p-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          {notice && (
            <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              {notice}
            </p>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="assistant-model" className="shrink-0 text-xs text-muted-foreground">
              数据模型
            </label>
            <select
              id="assistant-model"
              className="h-8 w-64 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              value={selectedModel}
              disabled={sending || models.length === 0}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              <option value="">全部模型</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              title="查看会话长度"
              aria-label="查看会话长度"
              onClick={openStats}
            >
              <Ruler />
            </Button>
            <span className="truncate text-xs text-muted-foreground">
              {selectedModel ? '问题仅针对所选模型' : '未指定时由助手在全部模型中判断'}
            </span>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              className="min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              rows={2}
              placeholder="输入问题，Enter 发送，Shift + Enter 换行"
              value={input}
              disabled={sending || (status !== null && !status.configured)}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              onClick={() => void send()}
              disabled={sending || !input.trim() || (status !== null && !status.configured)}
            >
              <Send /> 发送
            </Button>
          </div>
        </div>
      </section>

      <Modal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        title="会话长度"
        className="max-w-md"
        footer={
          <Button
            variant="outline"
            size="sm"
            title="用大模型把历史对话压缩成摘要，减少下发给模型的上下文长度"
            disabled={
              !activeId ||
              compressing ||
              sending ||
              !stats ||
              stats.uncompressedMessages === 0 ||
              (status !== null && !status.configured)
            }
            onClick={() => void compressConversation()}
          >
            <Minimize2 />
            {compressing ? '压缩中…' : '压缩历史对话'}
          </Button>
        }
      >
        {stats ? (
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">总长度</dt>
            <dd>{formatBytes(stats.totalBytes)}</dd>
            <dt className="text-muted-foreground">消息条数</dt>
            <dd>{stats.messageCount} 条</dd>
            <dt className="text-muted-foreground">模型上下文</dt>
            <dd>{formatBytes(stats.contextBytes)}</dd>
            <dt className="text-muted-foreground">摘要长度</dt>
            <dd>
              {stats.compressed
                ? `${formatBytes(stats.summaryBytes)}（已压缩至第 ${stats.compressedUntilSeq} 条）`
                : '未压缩'}
            </dd>
            <dt className="text-muted-foreground">待压缩</dt>
            <dd>{stats.uncompressedMessages} 条</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">当前为新对话，暂无会话数据。</p>
        )}
        <p className="text-xs text-muted-foreground">
          压缩会用大模型把较早的消息生成摘要，后续提问改为下发摘要，从而减少上下文长度；原始消息仍保留在会话中。
        </p>
        {compressError && <ErrorNote>{compressError}</ErrorNote>}
        {compressNotice && (
          <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            {compressNotice}
          </p>
        )}
      </Modal>

      <Modal
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        title="调试：发送给智能体的内容"
        className="max-w-4xl"
        footer={
          <Button variant="outline" size="sm" disabled={!debug} onClick={copyDebug}>
            <Copy /> 复制 JSON
          </Button>
        }
      >
        {debug ? (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">模型</dt>
              <dd>{debug.model}</dd>
              <dt className="text-muted-foreground">接口地址</dt>
              <dd className="break-all">{debug.apiBase}</dd>
              <dt className="text-muted-foreground">调用轮次</dt>
              <dd>{debug.rounds.length} 次</dd>
              {debug.error && (
                <>
                  <dt className="text-muted-foreground">最终错误</dt>
                  <dd className="text-destructive">{debug.error}</dd>
                </>
              )}
            </dl>
            {debug.rounds.map((round) => (
              <section key={round.attempt} className="rounded-md border border-border">
                <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
                  <span className="text-xs font-medium">第 {round.attempt} 次调用</span>
                  <span className="text-xs text-muted-foreground">{round.messages.length} 条消息</span>
                </div>
                <div className="space-y-2 p-3">
                  {round.messages.map((m, idx) => (
                    <div key={`${m.role}-${idx}`} className="space-y-1">
                      <span
                        className={cn(
                          'inline-block rounded px-1.5 py-0.5 text-[11px] font-medium',
                          m.role === 'system'
                            ? 'bg-accent text-accent-foreground'
                            : m.role === 'user'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {m.role === 'system' ? '系统提示词' : m.role === 'user' ? '用户' : '助手'}
                      </span>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5 text-xs leading-relaxed">
                        <code>{m.content}</code>
                      </pre>
                    </div>
                  ))}
                  {round.response && (
                    <div className="space-y-1">
                      <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        模型返回
                      </span>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5 text-xs leading-relaxed">
                        <code>{round.response}</code>
                      </pre>
                    </div>
                  )}
                  {round.error && <p className="text-xs text-destructive">本轮错误：{round.error}</p>}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">还没有发送过消息，先提一个问题再查看。</p>
        )}
      </Modal>
    </div>
  );
}

/** 助手生成的 SQL 卡片：复制与重新运行。 */
function SqlCard({ sql, onRerun }: { sql: string; onRerun: () => void }) {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    void navigator.clipboard
      ?.writeText(sql)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  return (
    <div className="rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
        <span className="text-xs font-medium text-muted-foreground">生成的 SQL</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={copy}>
            <Copy /> {copied ? '已复制' : '复制'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRerun}>
            <Play /> 运行
          </Button>
        </div>
      </div>
      <pre className="max-h-48 overflow-auto px-3 py-2 text-xs leading-relaxed">
        <code>{sql}</code>
      </pre>
    </div>
  );
}

