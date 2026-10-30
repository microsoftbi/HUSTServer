import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantConfig } from '../src/modules/assistant/config.js';
import {
  normalizeSlots,
  parseJsonObject,
  sanitizeSpec,
  slotsReady,
  type AgentModel,
  type AgentSlots,
} from '../src/modules/dashboardAgent/schema.js';
import { createDashboardAgentService } from '../src/modules/dashboardAgent/service.js';

const COLUMNS = [
  { name: 'country', type: 'VARCHAR' },
  { name: 'order_date', type: 'TIMESTAMP' },
  { name: 'amount', type: 'DOUBLE' },
];

const model: AgentModel = { name: 'orders', rowCount: 100, ownerId: null, columns: COLUMNS };

/** 未配置 API Key 的配置：解析与生成都不调用大模型 */
const cfg: AssistantConfig = { apiBase: 'http://llm.local/v1', model: 'test', apiKey: null };
const cfgWithKey: AssistantConfig = { ...cfg, apiKey: 'sk-test' };

/** 构造只返回固定内容的 LLM 响应 */
function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function confirmedSlots(): AgentSlots {
  return {
    model: 'orders',
    slicers: [{ field: 'country', type: 'dropdown' }],
    kpis: [{ title: '总销售额', field: 'amount', agg: 'sum' }],
    charts: [
      { type: 'bar', title: '各国销售额', dimension: 'country', measures: [{ field: 'amount', agg: 'sum' }] },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeSpec（生成规格校验）', () => {
  it('剔除不存在的字段并给出告警', () => {
    const { spec, warnings } = sanitizeSpec(
      { slicers: [{ field: 'not_exist' }, { field: 'country', type: 'dropdown' }] },
      COLUMNS,
    );
    expect(spec.slicers).toEqual([{ field: 'country', type: 'dropdown' }]);
    expect(warnings.some((w) => w.includes('not_exist'))).toBe(true);
  });

  it('日期字段的区间切片器保留「介于」，非日期字段降级为下拉', () => {
    const { spec, warnings } = sanitizeSpec(
      {
        slicers: [
          { field: 'order_date', type: 'between' },
          { field: 'country', type: 'between' },
        ],
      },
      COLUMNS,
    );
    expect(spec.slicers[0]).toEqual({ field: 'order_date', type: 'between' });
    expect(spec.slicers[1]).toEqual({ field: 'country', type: 'dropdown' });
    expect(warnings.some((w) => w.includes('下拉'))).toBe(true);
  });

  it('非数值列的 sum 被剔除，count 允许', () => {
    const { spec } = sanitizeSpec(
      {
        kpis: [
          { title: 'A', field: 'country', agg: 'sum' },
          { title: 'B', field: 'country', agg: 'count' },
        ],
      },
      COLUMNS,
    );
    expect(spec.kpis).toEqual([{ title: 'B', field: 'country', agg: 'count' }]);
  });

  it('图表类型不在白名单时回退柱形图，无度量或缺少维度的图表被忽略', () => {
    const { spec } = sanitizeSpec(
      {
        charts: [
          { type: 'radar', title: '雷达', dimension: 'country', measures: [{ field: 'amount', agg: 'sum' }] },
          { type: 'bar', title: '无度量', dimension: 'country', measures: [] },
          { type: 'pie', title: '无维度', measures: [{ field: 'amount', agg: 'sum' }] },
          { type: 'table', title: '表格', measures: [{ field: 'amount', agg: 'sum' }] },
        ],
      },
      COLUMNS,
    );
    expect(spec.charts.map((c) => c.type)).toEqual(['bar', 'table']);
  });

  it('数值维度只允许 table / matrix / scatter', () => {
    const { spec } = sanitizeSpec(
      {
        charts: [
          { type: 'bar', title: '柱', dimension: 'amount', measures: [{ field: 'amount', agg: 'sum' }] },
          { type: 'table', title: '表', dimension: 'amount', measures: [{ field: 'amount', agg: 'sum' }] },
        ],
      },
      COLUMNS,
    );
    expect(spec.charts).toHaveLength(1);
    expect(spec.charts[0].type).toBe('table');
  });

  it('数量超过上限时截断并告警', () => {
    const wide = Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, type: 'VARCHAR' }));
    const slicers = wide.map((c) => ({ field: c.name, type: 'dropdown' }));
    const { spec, warnings } = sanitizeSpec({ slicers }, wide);
    expect(spec.slicers).toHaveLength(5);
    expect(warnings.some((w) => w.includes('最多'))).toBe(true);
  });
});

describe('normalizeSlots / parseJsonObject', () => {
  it('null 表示未确认，空数组表示明确不要', () => {
    const slots = normalizeSlots({ model: 'orders', slicers: [], kpis: null });
    expect(slots.slicers).toEqual([]);
    expect(slots.kpis).toBeNull();
    expect(slotsReady(slots)).toBe(false);
  });

  it('容忍代码块包裹的 JSON 输出', () => {
    const parsed = parseJsonObject('说明\n```json\n{"slicers": []}\n```');
    expect(parsed).toEqual({ slicers: [] });
  });
});

describe('plan（逐项确认）', () => {
  const service = createDashboardAgentService();
  const other: AgentModel = {
    name: 'users',
    rowCount: 20,
    ownerId: null,
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'name', type: 'VARCHAR' },
    ],
  };

  it('只有一个模型时自动采用，并只问一个槽位', async () => {
    const res = await service.plan({
      prompt: '帮我做一个销售仪表板',
      models: [model],
      cfg,
    });
    expect(res.slots.model).toBe('orders');
    expect(res.ready).toBe(false);
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0].slot).toBe('slicers');
    expect(res.questions[0].recommended).toBeDefined();
    expect(res.confirmed).toBe(1);
  });

  it('识别「不要筛选器」并继续问下一项', async () => {
    const res = await service.plan({
      prompt: '用 orders 做一个仪表板，不要筛选器',
      models: [model],
      cfg,
    });
    expect(res.slots.slicers).toEqual([]);
    expect(res.questions[0].slot).toBe('kpis');
  });

  it('需求里出现「柱形图」不视为「不要图表」', async () => {
    const res = await service.plan({
      prompt: '用 orders 做一个看板：按 country 放筛选器，展示 amount 的合计，再加一个按 country 的柱形图',
      slots: { model: 'orders', slicers: [], kpis: [], charts: null },
      models: [model],
      cfg,
    });
    expect(res.slots.charts).toBeNull();
    expect(res.questions[0].slot).toBe('charts');
  });

  it('槽位齐全时不再提问', async () => {
    const res = await service.plan({
      prompt: '用 orders 做仪表板',
      slots: confirmedSlots(),
      models: [model],
      cfg,
    });
    expect(res.ready).toBe(true);
    expect(res.questions).toEqual([]);
    expect(res.confirmed).toBe(4);
  });

  it('多个模型时由大模型按需求语义挑选，不再追问模型', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content: string }> };
        const text = (body.messages ?? []).map((m) => m.content).join('\n');
        // 第一次是模型选择，第二次是槽位抽取
        return llmResponse(
          text.includes('候选模型')
            ? JSON.stringify({ model: 'orders' })
            : JSON.stringify({ slicers: [], kpis: [], charts: [] }),
        );
      }),
    );
    const res = await service.plan({
      prompt: '做一个订单销售分析看板，按国家看销售额',
      models: [model, other],
      cfg: cfgWithKey,
    });
    expect(res.slots.model).toBe('orders');
    expect(res.questions.every((q) => q.slot !== 'model')).toBe(true);
    expect(res.warnings.some((w) => w.includes('自动选择数据模型'))).toBe(true);
    expect(res.debug).toHaveLength(2);
  });

  it('大模型也挑不出模型时回到模型提问', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => llmResponse(JSON.stringify({ model: null }))),
    );
    const res = await service.plan({
      prompt: '随便看看数据',
      models: [model, other],
      cfg: cfgWithKey,
    });
    expect(res.slots.model).toBeNull();
    expect(res.questions[0].slot).toBe('model');
  });

  it('模型不存在时重新提问模型槽位', async () => {
    const res = await service.plan({
      prompt: '做一个仪表板',
      slots: { ...confirmedSlots(), model: 'missing' },
      models: [model],
      cfg,
    });
    expect(res.slots.model).toBe('orders');
    expect(res.ready).toBe(true);
  });
});

describe('generate（生成规格）', () => {
  const service = createDashboardAgentService();
  const input = { prompt: '各国销售额分析', slots: confirmedSlots(), models: [model] };

  it('未配置 API Key 时用本地模板兜底', async () => {
    const res = await service.generate({ ...input, cfg });
    expect(res.source).toBe('template');
    expect(res.spec.slicers).toHaveLength(1);
    expect(res.spec.kpis).toHaveLength(1);
    expect(res.spec.charts).toHaveLength(1);
    expect(res.spec.name).toContain('各国销售额');
  });

  it('大模型返回合法规格时采用大模型结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        llmResponse(
          JSON.stringify({
            name: '销售总览',
            slicers: [{ field: 'country', type: 'dropdown' }],
            kpis: [{ title: '销售额合计', field: 'amount', agg: 'sum' }],
            charts: [
              {
                type: 'bar',
                title: '各国销售额',
                dimension: 'country',
                measures: [{ field: 'amount', agg: 'sum' }],
              },
            ],
          }),
        ),
      ),
    );
    const res = await service.generate({ ...input, cfg: cfgWithKey });
    expect(res.source).toBe('llm');
    expect(res.spec.name).toBe('销售总览');
    expect(res.spec.kpis[0].title).toBe('销售额合计');
    // 调试信息：包含完整提示词（system + user）与大模型原始返回
    expect(res.debug).toHaveLength(1);
    expect(res.debug[0].stage).toBe('generate');
    expect(res.debug[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(res.debug[0].messages[1].content).toContain('各国销售额分析');
    expect(res.debug[0].response).toContain('销售总览');
  });

  it('未配置 API Key 时不产生调试记录', async () => {
    const res = await service.generate({ ...input, cfg });
    expect(res.debug).toEqual([]);
  });

  it('大模型漏掉已确认对象时回退模板并告警', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        llmResponse(
          JSON.stringify({
            name: '残缺',
            slicers: [],
            kpis: [],
            charts: [],
          }),
        ),
      ),
    );
    const res = await service.generate({ ...input, cfg: cfgWithKey });
    expect(res.source).toBe('template');
    expect(res.spec.charts).toHaveLength(1);
    expect(res.warnings.some((w) => w.includes('本地模板'))).toBe(true);
  });

  it('未选择模型时直接报错', async () => {
    await expect(
      service.generate({ ...input, slots: { ...confirmedSlots(), model: null }, cfg }),
    ).rejects.toThrow('请先选择要连接的数据模型');
  });
});
