import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';
import { auditRepo } from '../src/modules/audit/repo.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { dataModelsRepo } from '../src/modules/models/repo.js';
import { usersRepo } from '../src/modules/users/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

let app: FastifyInstance;
let db: Database.Database;
let viewerCookie: string;
let authorCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

/** 写入一个 orders 模型：文本维度 + 数值度量 + 日期列 */
function seedOrders(): void {
  dataModelsRepo(db).upsert({
    name: 'orders',
    sourceKind: 'csv',
    sourceRef: '{}',
    ownerId: null,
    loadedAt: Date.now(),
    rowCount: 3,
    columns: JSON.stringify([
      { name: 'region', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
      { name: 'order_date', type: 'DATE' },
    ]),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({
    username: 'viewer',
    passwordHash: await hashPassword('viewer123'),
    roles: ['dashboard_viewer'],
  });
  await usersRepo(db).create({
    username: 'author',
    passwordHash: await hashPassword('author123'),
    roles: ['dashboard_author'],
  });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  viewerCookie = await login('viewer', 'viewer123');
  authorCookie = await login('author', 'author123');
});

describe('仪表板智能体路由门禁', () => {
  it('未登录返回 401', async () => {
    const plan = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      payload: { prompt: '做一个销售看板' },
    });
    expect(plan.statusCode).toBe(401);
  });

  it('dashboard_viewer 可看模型列表，但不能解析与生成（403）', async () => {
    seedOrders();
    const models = await app.inject({
      method: 'GET',
      url: '/api/dashboard-agent/models',
      headers: { cookie: viewerCookie },
    });
    expect(models.statusCode).toBe(200);
    expect(models.json().items.map((m: { name: string }) => m.name)).toEqual(['orders']);

    const plan = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: viewerCookie },
      payload: { prompt: '做一个销售看板' },
    });
    expect(plan.statusCode).toBe(403);

    const generate = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/generate',
      headers: { cookie: viewerCookie },
      payload: { prompt: '做一个销售看板', slots: { model: 'orders' } },
    });
    expect(generate.statusCode).toBe(403);
  });
});

describe('POST /api/dashboard-agent/plan', () => {
  it('没有可用模型时提示先加载数据模型', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: { prompt: '做一个销售看板' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('还没有可用的数据模型，请先加载数据模型');
  });

  it('空需求描述返回 400', async () => {
    seedOrders();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: { prompt: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('请输入需求描述');
  });

  it('需求里提到模型名时自动采用，并逐项提问直到齐全', async () => {
    seedOrders();
    const first = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: { prompt: '用 orders 做一个销售看板' },
    });
    expect(first.statusCode).toBe(200);
    const a = first.json();
    expect(a.slots.model).toBe('orders');
    expect(a.ready).toBe(false);
    expect(a.confirmed).toBe(1);
    expect(a.questions[0].slot).toBe('slicers');

    const second = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: {
        prompt: '用 orders 做一个销售看板',
        slots: a.slots,
        answer: { slot: 'slicers', value: '[]' },
      },
    });
    expect(second.json().slots.slicers).toEqual([]);
    expect(second.json().questions[0].slot).toBe('kpis');

    const third = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: {
        prompt: '用 orders 做一个销售看板',
        slots: second.json().slots,
        answer: { slot: 'kpis', value: '[]' },
      },
    });
    expect(third.json().questions[0].slot).toBe('charts');

    const done = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: {
        prompt: '用 orders 做一个销售看板',
        slots: third.json().slots,
        answer: { slot: 'charts', value: '[]' },
      },
    });
    expect(done.json().ready).toBe(true);
    expect(done.json().questions).toEqual([]);
    expect(done.json().confirmed).toBe(4);
  });

  it('多个模型且需求未提及名称时先问模型', async () => {
    seedOrders();
    dataModelsRepo(db).upsert({
      name: 'customers',
      sourceKind: 'csv',
      sourceRef: '{}',
      ownerId: null,
      loadedAt: Date.now(),
      rowCount: 2,
      columns: JSON.stringify([{ name: 'name', type: 'VARCHAR' }]),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/plan',
      headers: { cookie: authorCookie },
      payload: { prompt: '做一个销售看板' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slots.model).toBeNull();
    expect(res.json().questions[0].slot).toBe('model');
    expect(res.json().questions[0].options).toHaveLength(2);
  });
});

describe('POST /api/dashboard-agent/generate', () => {
  it('未选模型时 400', async () => {
    seedOrders();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/generate',
      headers: { cookie: authorCookie },
      payload: { prompt: '做一个销售看板', slots: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('请先选择要连接的数据模型');
  });

  it('模型不可访问时 400', async () => {
    seedOrders();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/generate',
      headers: { cookie: authorCookie },
      payload: { prompt: '做一个销售看板', slots: { model: 'missing' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('数据模型「missing」不存在或无权访问');
  });

  it('未配置大模型时按已确认槽位走本地模板，并写审计', async () => {
    seedOrders();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard-agent/generate',
      headers: { cookie: authorCookie },
      payload: {
        prompt: '帮我做 orders 的销售看板',
        slots: {
          model: 'orders',
          slicers: [],
          kpis: [{ title: '销售额', field: 'amount', agg: 'sum' }],
          charts: [
            { type: 'bar', title: '按地区统计', dimension: 'region', measures: [{ field: 'amount', agg: 'sum' }] },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('template');
    expect(body.spec.name).toBe('orders 的销售');
    expect(body.spec.kpis).toHaveLength(1);
    expect(body.spec.charts).toHaveLength(1);

    const logs = auditRepo(db).list({ limit: 10, offset: 0, resource: 'dashboard' });
    expect(logs.total).toBe(1);
    expect(logs.items[0]!.description).toContain('AI 生成仪表板');
    expect(logs.items[0]!.description).toContain('本地模板');
  });
});
