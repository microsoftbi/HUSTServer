import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';
import { assistantRepo } from '../src/modules/assistant/repo.js';
import { createAssistantService } from '../src/modules/assistant/service.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { dataModelsRepo, modelLabelsRepo } from '../src/modules/models/repo.js';
import type { ModelStore } from '../src/modules/models/service.js';
import type { QueryResult } from '../src/modules/data/query.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const RESULT: QueryResult = {
  columns: [{ name: 'amount', type: 'number' }],
  rows: [[1]],
  truncated: false,
};

/** 构造只返回固定内容的 LLM 响应。 */
function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function planResponse(plan: { sql?: string; answer?: string; needsClarification?: string }): Response {
  return llmResponse(JSON.stringify({ answer: '', needsClarification: '', ...plan }));
}

describe('assistant service（Text2SQL 流水线）', () => {
  let db: Database.Database;
  let userId: string;
  let rawQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    const users = (await import('../src/modules/users/repo.js')).usersRepo(db);
    const user = users.create({
      username: 'tester',
      passwordHash: await hashPassword('tester123'),
      roles: ['admin'],
    });
    userId = user.id;
    dataModelsRepo(db).upsert({
      name: 'orders',
      sourceKind: 'csv',
      sourceRef: '{}',
      ownerId: null,
      loadedAt: Date.now(),
      rowCount: 1,
      columns: JSON.stringify([{ name: 'amount', type: 'DOUBLE' }]),
    });
    rawQuery = vi.fn(async () => RESULT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function service() {
    return createAssistantService({
      modelStore: { rawQuery } as unknown as ModelStore,
      models: dataModelsRepo(db),
      labels: modelLabelsRepo(db),
      repo: assistantRepo(db),
    });
  }

  const cfgValue = { apiBase: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test' };

  it('成功路径：生成 SQL、执行查询并持久化会话与两条消息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => planResponse({ sql: 'SELECT amount FROM orders', answer: '共 1 行' })),
    );

    const res = await service().chat({ userId, question: '统计金额', cfg: cfgValue });

    expect(res.message.role).toBe('assistant');
    expect(res.message.sql).toBe('SELECT amount FROM orders');
    expect(res.message.content).toBe('共 1 行');
    expect(res.message.result).toEqual(RESULT);
    expect(rawQuery).toHaveBeenCalledWith('SELECT amount FROM orders', expect.any(Number));

    const conversations = assistantRepo(db).listConversations(userId);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.title).toBe('统计金额');
    const messages = assistantRepo(db).listMessages(res.conversationId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('只读校验失败时回灌错误并重试一次，最终不执行 SQL', async () => {
    const fetchMock = vi.fn(async () => planResponse({ sql: 'DELETE FROM orders', answer: '' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await service().chat({ userId, question: '删掉全部', cfg: cfgValue });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rawQuery).not.toHaveBeenCalled();
    expect(res.message.content).toContain('未能完成查询');
    expect(res.message.content).toContain('只读');
    expect(res.message.result).toBeNull();
  });

  it('引用不存在的表时按错误回灌重试', async () => {
    const fetchMock = vi.fn(async () => planResponse({ sql: 'SELECT * FROM missing', answer: '' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await service().chat({ userId, question: '随便查', cfg: cfgValue });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rawQuery).not.toHaveBeenCalled();
    expect(res.message.content).toContain('missing');
  });

  it('首次 SQL 失败、第二次修正后成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(planResponse({ sql: 'DELETE FROM orders', answer: '' }))
      .mockResolvedValueOnce(planResponse({ sql: 'SELECT amount FROM orders', answer: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await service().chat({ userId, question: '金额', cfg: cfgValue });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.message.sql).toBe('SELECT amount FROM orders');
    expect(res.message.result).toEqual(RESULT);
  });

  it('模型只追问不查数时不执行 SQL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => planResponse({ needsClarification: '请指定时间范围' })),
    );

    const res = await service().chat({ userId, question: '查一下数据', cfg: cfgValue });

    expect(res.message.sql).toBeNull();
    expect(res.message.result).toBeNull();
    expect(res.message.content).toBe('请指定时间范围');
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it('指定数据模型时只暴露该模型，并在提示词中带上数据标签', async () => {
    dataModelsRepo(db).upsert({
      name: 'customers',
      sourceKind: 'csv',
      sourceRef: '{}',
      ownerId: null,
      loadedAt: Date.now(),
      rowCount: 2,
      columns: JSON.stringify([{ name: 'name', type: 'VARCHAR' }]),
    });
    modelLabelsRepo(db).save('orders', '订单金额已含税');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      planResponse({ sql: 'SELECT amount FROM orders', answer: 'ok' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await service().chat({
      userId,
      question: '金额',
      modelName: 'orders',
      cfg: cfgValue,
    });

    expect(res.message.sql).toBe('SELECT amount FROM orders');
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages[0]!.content;
    expect(system).toContain('表名 orders');
    expect(system).not.toContain('表名 customers');
    expect(system).toContain('订单金额已含税');
  });

  it('指定模型后引用其他模型会按错误回灌，最终不执行 SQL', async () => {
    dataModelsRepo(db).upsert({
      name: 'customers',
      sourceKind: 'csv',
      sourceRef: '{}',
      ownerId: null,
      loadedAt: Date.now(),
      rowCount: 2,
      columns: JSON.stringify([{ name: 'name', type: 'VARCHAR' }]),
    });
    const fetchMock = vi.fn(async () => planResponse({ sql: 'SELECT * FROM customers', answer: '' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await service().chat({
      userId,
      question: '查客户',
      modelName: 'orders',
      cfg: cfgValue,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rawQuery).not.toHaveBeenCalled();
    expect(res.message.content).toContain('customers');
  });

  it('压缩历史对话后，统计变小并且后续提问只带摘要与新消息', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      planResponse({ sql: 'SELECT amount FROM orders', answer: '共 1 行' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await service().chat({ userId, question: '统计订单金额', cfg: cfgValue });
    const conversationId = first.conversationId;

    const before = service().stats({ userId, conversationId });
    expect(before.messageCount).toBe(2);
    expect(before.compressed).toBe(false);
    expect(before.totalBytes).toBeGreaterThan(0);

    fetchMock.mockImplementation(async () => llmResponse('用户想统计订单金额，结果为 1 行。'));
    const compressed = await service().compress({ userId, conversationId, cfg: cfgValue });

    expect(compressed.summary).toBe('用户想统计订单金额，结果为 1 行。');
    expect(compressed.compressedUntilSeq).toBe(2);
    expect(compressed.compressedMessages).toBe(2);
    expect(compressed.stats.compressed).toBe(true);
    expect(compressed.stats.contextBytes).toBeLessThan(before.totalBytes);
    expect(compressed.stats.summaryBytes).toBeGreaterThan(0);
    expect(assistantRepo(db).findConversation(conversationId, userId)!.summary).toBe(
      compressed.summary,
    );

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () =>
      planResponse({ sql: 'SELECT amount FROM orders', answer: 'ok' }),
    );
    await service().chat({ userId, question: '再查一次', conversationId, cfg: cfgValue });

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(body.messages[1]!.content).toContain('用户想统计订单金额');
    expect(body.messages[2]!.content).toBe('再查一次');

    // 再次压缩：只总结新增消息，并把已有摘要一并带入，避免信息丢失
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => llmResponse('用户先统计金额，又追问了一次。'));
    const second = await service().compress({ userId, conversationId, cfg: cfgValue });
    expect(second.compressedMessages).toBe(2);
    expect(second.compressedUntilSeq).toBe(4);

    const compressBody = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };
    const transcript = compressBody.messages[1]!.content;
    expect(transcript).toContain('已有摘要');
    expect(transcript).toContain('用户想统计订单金额');
    expect(transcript).not.toContain('系统');
    expect(service().stats({ userId, conversationId }).uncompressedMessages).toBe(0);
  });

  it('空会话不允许压缩', async () => {
    const conversation = assistantRepo(db).createConversation(userId, '空对话');
    await expect(
      service().compress({ userId, conversationId: conversation.id, cfg: cfgValue }),
    ).rejects.toThrow('还没有消息');
  });
});

describe('assistant routes', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let viewerCookie: string;

  async function login(username: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    return res.headers['set-cookie']!.toString().split(';')[0]!;
  }

  beforeEach(async () => {
    const db = new Database(':memory:');
    migrate(db);
    const users = (await import('../src/modules/users/repo.js')).usersRepo(db);
    users.create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
    users.create({
      username: 'viewer',
      passwordHash: await hashPassword('viewer123'),
      roles: ['dashboard_viewer'],
    });
    app = await buildServer({ db, config: cfg, logger: false });
    await app.ready();
    adminCookie = await login('admin', 'admin123');
    viewerCookie = await login('viewer', 'viewer123');
  });

  afterEach(async () => {
    await app.close();
  });

  it('未登录 401，无连接使用权限 403', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/assistant/status' });
    expect(anon.statusCode).toBe(401);
    const viewer = await app.inject({
      method: 'GET',
      url: '/api/assistant/status',
      headers: { cookie: viewerCookie },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('未配置 API Key 时先返回未配置，再拒绝对话', async () => {
    const status = await app.inject({
      method: 'GET',
      url: '/api/assistant/status',
      headers: { cookie: adminCookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ configured: false, model: 'deepseek-chat' });

    const chat = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      headers: { cookie: adminCookie },
      payload: { question: '有多少行？' },
    });
    expect(chat.statusCode).toBe(400);
    expect((chat.json() as { error: string }).error).toBe('assistant_not_configured');
  });

  it('设置 API Key 后只回传 hasApiKey，数据库中为密文', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: adminCookie },
      payload: { assistantApiKey: 'sk-secret-value', assistantModel: 'deepseek-reasoner' },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { assistant: { hasApiKey: boolean; model: string } };
    expect(body.assistant).toEqual({ apiBase: 'https://api.deepseek.com', model: 'deepseek-reasoner', hasApiKey: true });
    expect(JSON.stringify(body)).not.toContain('sk-secret-value');

    const status = await app.inject({
      method: 'GET',
      url: '/api/assistant/status',
      headers: { cookie: adminCookie },
    });
    expect(status.json()).toMatchObject({ configured: true });
  });
});
