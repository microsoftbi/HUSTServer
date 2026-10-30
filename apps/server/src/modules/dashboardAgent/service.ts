import type { AssistantConfig } from '../assistant/config.js';
import { callLlm } from '../assistant/service.js';
import { buildGeneratePrompt, buildModelPickPrompt, buildPlanPrompt } from './prompt.js';
import {
  logicalTypeOf,
  normalizeSlots,
  parseJsonObject,
  parseSlotsOutput,
  resolveField,
  sanitizeSpec,
  slotsReady,
  type AgentModel,
  type AgentSlots,
  type DashboardSpec,
  type SlotKey,
  type SpecChart,
  type SpecKpi,
  type SpecSlicer,
} from './schema.js';

/** 前端可回传的对话历史条数上限 */
const HISTORY_LIMIT = 6;
/** 生成阶段失败后带错误信息重试的次数上限（含首次） */
const MAX_ATTEMPTS = 2;

export interface AgentQuestionOption {
  label: string;
  /** 槽位值的 JSON 字符串（前端原样回传） */
  value: string;
}

export interface AgentQuestion {
  slot: SlotKey;
  question: string;
  options: AgentQuestionOption[];
  allowFreeText: boolean;
  /** 推荐选项的 value（「你来定」直接使用） */
  recommended?: string;
}

export interface AgentAnswer {
  slot: SlotKey;
  value?: string;
  text?: string;
}

export interface PlanInput {
  prompt: string;
  slots?: unknown;
  answer?: AgentAnswer;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  models: AgentModel[];
  cfg: AssistantConfig;
}

/** 调试信息：一次真实发往大模型的请求（含提示词与原始返回），供前端「调试」窗口展示 */
export interface AgentDebugEntry {
  stage: 'plan' | 'generate';
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 大模型原始返回（失败时为空） */
  response?: string;
  error?: string;
}

export interface PlanResult {
  slots: AgentSlots;
  questions: AgentQuestion[];
  ready: boolean;
  warnings: string[];
  /** 已完成确认的槽位数量（1-4），供前端展示进度 */
  confirmed: number;
  /** 本轮实际调用大模型的调试记录（未调用时为空数组） */
  debug: AgentDebugEntry[];
}

export interface GenerateInput {
  prompt: string;
  slots: unknown;
  models: AgentModel[];
  cfg: AssistantConfig;
}

export interface GenerateResult {
  spec: DashboardSpec;
  warnings: string[];
  /** llm = 大模型生成；template = 本地模板兜底 */
  source: 'llm' | 'template';
  /** 每次尝试调用大模型的调试记录（未调用时为空数组） */
  debug: AgentDebugEntry[];
}

export interface DashboardAgentService {
  plan(input: PlanInput): Promise<PlanResult>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

/** 形如 id / 编号 / 编码 的列不适合做维度或度量 */
function isIdLike(name: string): boolean {
  return /(^|[_\s])id$|id$|编号|代码|编码/i.test(name);
}

interface Recommendation {
  slicers: SpecSlicer[];
  kpis: SpecKpi[];
  charts: SpecChart[];
}

/** 按列类型给出推荐结构：日期→趋势，文本→分类，数值→度量 */
export function recommendForModel(model: AgentModel): Recommendation {
  const dates = model.columns.filter((c) => logicalTypeOf(c) === 'date');
  const texts = model.columns.filter(
    (c) => logicalTypeOf(c) === 'string' || logicalTypeOf(c) === 'boolean',
  );
  const numbers = model.columns.filter((c) => logicalTypeOf(c) === 'number');
  const dims = texts.filter((c) => !isIdLike(c.name)).slice(0, 3);
  const measures = numbers.filter((c) => !isIdLike(c.name)).slice(0, 3);
  const numeric = measures[0]?.name;

  const slicers: SpecSlicer[] = [];
  if (dates[0]) slicers.push({ field: dates[0].name, type: 'between' });
  for (const dim of dims.slice(0, 3)) slicers.push({ field: dim.name, type: 'dropdown' });

  const kpis: SpecKpi[] = measures.map((m) => ({ title: m.name, field: m.name, agg: 'sum' }));

  const charts: SpecChart[] = [];
  if (dims[0] && numeric) {
    charts.push({
      type: 'bar',
      title: `按 ${dims[0].name} 统计 ${numeric}`,
      dimension: dims[0].name,
      measures: [{ field: numeric, agg: 'sum' }],
    });
  }
  if (dates[0] && numeric) {
    charts.push({
      type: 'line',
      title: `${numeric} 趋势`,
      dimension: dates[0].name,
      measures: [{ field: numeric, agg: 'sum' }],
    });
  }
  if (dims[1] && numeric) {
    charts.push({
      type: 'pie',
      title: `${dims[1].name} 占比`,
      dimension: dims[1].name,
      measures: [{ field: numeric, agg: 'sum' }],
    });
  }
  // 没有数值列时退化为表格（用行数作为度量）
  if (charts.length === 0 && dims[0]) {
    charts.push({
      type: 'table',
      title: dims[0].name,
      dimension: dims[0].name,
      measures: [{ field: dims[0].name, agg: 'count' }],
    });
  }

  return { slicers, kpis, charts };
}

/** 用户明确说「不要筛选器 / 不要图表」时把槽位置为空数组 */
export function applyNegatives(prompt: string, slots: AgentSlots): void {
  const negative = /(不要|不需要|不用|去掉|移除|删掉|无需)/;
  const clause = prompt.replace(/\s+/g, '');
  // 关键词必须加分组：否则「图表|图」的「|」会作用到整个表达式上，
  // 变成「否定词+图表」或「图」，只要需求里出现「图」就会被误判为「不要图表」。
  const has = (pattern: RegExp) =>
    new RegExp(`${negative.source}[^，。；、\\n]{0,8}(?:${pattern.source})`).test(clause);
  if (slots.slicers === null && has(/筛选|切片/)) slots.slicers = [];
  if (slots.kpis === null && has(/卡片|kpi|指标/i)) slots.kpis = [];
  if (slots.charts === null && has(/图表|图/)) slots.charts = [];
}

function option(label: string, value: unknown): AgentQuestionOption {
  return { label, value: JSON.stringify(value) };
}

/** 模型槽位：列出全部可见模型供单选 */
function modelQuestion(models: AgentModel[], prompt: string): AgentQuestion {
  const picked = models.find((m) => prompt.includes(m.name)) ?? models[0];
  return {
    slot: 'model',
    question: '要连接哪个数据模型？',
    options: models.map((m) => option(`${m.name}（${m.rowCount} 行）`, m.name)),
    allowFreeText: false,
    ...(picked ? { recommended: JSON.stringify(picked.name) } : {}),
  };
}

function fieldList(items: Array<{ field: string }>): string {
  return items.map((item) => item.field).join('、');
}

/** 按槽位生成「候选 + 你来定」的选择题 */
export function buildQuestion(
  slot: Exclude<SlotKey, 'model'>,
  model: AgentModel,
  recommended: Recommendation,
): AgentQuestion {
  if (slot === 'slicers') {
    const options = [
      option(recommended.slicers.length ? `推荐：${fieldList(recommended.slicers)}` : '不要筛选器', recommended.slicers),
      option('不要筛选器', []),
    ];
    return {
      slot,
      question: '要放置哪些筛选器（切片器）？',
      options,
      allowFreeText: true,
      recommended: options[0].value,
    };
  }
  if (slot === 'kpis') {
    const options = [
      option(recommended.kpis.length ? `推荐：${fieldList(recommended.kpis)}` : '不要数据卡片', recommended.kpis),
      option('不要数据卡片', []),
    ];
    return {
      slot,
      question: '要放置哪些数据卡片（KPI）？',
      options,
      allowFreeText: true,
      recommended: options[0].value,
    };
  }
  const chartOptions = [
    option(
      recommended.charts.length
        ? `推荐：${recommended.charts.map((c) => c.title).join('、')}`
        : '不要图表',
      recommended.charts,
    ),
    option(
      '只要一个柱形图',
      recommended.charts.filter((c) => c.type === 'bar').slice(0, 1),
    ),
    option('不要图表', []),
  ];
  return {
    slot: 'charts',
    question: '要放置哪些图表？',
    options: chartOptions,
    allowFreeText: true,
    recommended: chartOptions[0].value,
  };
}

/** 把大模型抽取的槽位合并进当前槽位（只填 null，不覆盖已确认值） */
function mergeSlots(
  slots: AgentSlots,
  extracted: Partial<AgentSlots>,
  model: AgentModel,
  warnings: string[],
): void {
  const columns = model.columns;
  // 空数组视为「没抽到」而不是「明确不要」：明确不要已由 applyNegatives 提前置空，
  // 这里保持 null 可以继续追问，避免大模型漏答时静默丢掉用户要求的图表/卡片。
  if (slots.slicers === null && extracted.slicers?.length) {
    const { spec, warnings: w } = sanitizeSpec({ slicers: extracted.slicers }, columns);
    slots.slicers = spec.slicers;
    warnings.push(...w);
  }
  if (slots.kpis === null && extracted.kpis?.length) {
    const { spec, warnings: w } = sanitizeSpec({ kpis: extracted.kpis }, columns);
    slots.kpis = spec.kpis;
    warnings.push(...w);
  }
  if (slots.charts === null && extracted.charts?.length) {
    const { spec, warnings: w } = sanitizeSpec({ charts: extracted.charts }, columns);
    slots.charts = spec.charts;
    warnings.push(...w);
  }
}

/** 把前端回传的答案应用回槽位 */
function applyAnswer(
  slots: AgentSlots,
  models: AgentModel[],
  answer: AgentAnswer,
): string {
  if (answer.value !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.value);
    } catch {
      return '';
    }
    if (answer.slot === 'model') {
      const name = typeof parsed === 'string' ? parsed : '';
      const hit = models.find((m) => m.name === name);
      if (hit) slots.model = hit.name;
      return '';
    }
    if (Array.isArray(parsed)) {
      slots[answer.slot] = parsed as never;
    }
    return '';
  }
  return typeof answer.text === 'string' ? answer.text.trim() : '';
}

/** 从需求文本里猜一个仪表板名称 */
export function deriveName(prompt: string, modelName: string): string {
  const cleaned = prompt
    .replace(/(帮我|帮忙|请|给我|做一个|做个|生成|设计|创建|搭建)/g, '')
    // 「帮我做…」这类开头的动词单独去掉
    .replace(/^[\s，。,.!！?？；;：]*(做|来|画|搭|建)/, '')
    .replace(/(仪表板|仪表盘|看板|报表)/g, '')
    .replace(/[，。,.!！?？；;：:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || `${modelName} 分析`).slice(0, 16);
}

export function createDashboardAgentService(): DashboardAgentService {
  return {
    async plan(input) {
      const slots = normalizeSlots(input.slots);
      const models = input.models;
      const warnings: string[] = [];
      const debug: AgentDebugEntry[] = [];
      const answerText = input.answer ? applyAnswer(slots, models, input.answer) : '';
      const prompt = input.prompt.trim();
      const searchText = `${prompt} ${answerText}`;

      // 1. 模型槽位：先从需求文本里找唯一模型名；只有一个模型时直接采用；
      //    多个模型时先让大模型按语义挑选，挑不出来才向前端提问
      if (slots.model && !models.some((m) => m.name === slots.model)) {
        warnings.push(`数据模型「${slots.model}」不存在，请重新选择`);
        slots.model = null;
      }
      if (!slots.model) {
        const mentioned = models.filter((m) => searchText.includes(m.name));
        if (mentioned.length === 1) slots.model = mentioned[0].name;
        else if (models.length === 1) slots.model = models[0].name;
        else if (models.length > 1 && input.cfg.apiKey) {
          const messages = buildModelPickPrompt({
            models,
            prompt,
            history: (input.history ?? []).slice(-HISTORY_LIMIT),
          });
          const entry: AgentDebugEntry = { stage: 'plan', model: '（选择数据模型）', messages };
          try {
            const raw = await callLlm(input.cfg, messages);
            entry.response = raw;
            const picked = parseJsonObject(raw).model;
            const hit = typeof picked === 'string' ? models.find((m) => m.name === picked) : null;
            if (hit) {
              slots.model = hit.name;
              warnings.push(`已根据需求自动选择数据模型「${hit.name}」`);
            }
          } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
          } finally {
            debug.push(entry);
          }
        }
      }

      // 2. 「不要筛选器」这类明确否定，直接视为已确认的空集
      applyNegatives(searchText, slots);

      const model = models.find((m) => m.name === slots.model) ?? null;
      const recommended = model ? recommendForModel(model) : null;

      // 3. 模型确定后，用大模型抽取剩余槽位（只填未确认项）
      if (model && (!slots.slicers || !slots.kpis || !slots.charts) && input.cfg.apiKey) {
        const messages = buildPlanPrompt({
          model,
          prompt,
          slots,
          history: (input.history ?? []).slice(-HISTORY_LIMIT),
          ...(answerText ? { extraText: answerText } : {}),
        });
        const entry: AgentDebugEntry = { stage: 'plan', model: model.name, messages };
        try {
          const raw = await callLlm(input.cfg, messages);
          entry.response = raw;
          mergeSlots(slots, parseSlotsOutput(parseJsonObject(raw)), model, warnings);
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
          warnings.push('未能从需求中解析出可视化结构，已改用推荐值');
        } finally {
          debug.push(entry);
        }
      }

      // 4. 生成下一轮问题（一次只问一项）
      let questions: AgentQuestion[] = [];
      if (!slotsReady(slots)) {
        if (!model) {
          questions = [modelQuestion(models, searchText)];
        } else if (slots.slicers === null) {
          questions = [buildQuestion('slicers', model, recommended!)];
        } else if (slots.kpis === null) {
          questions = [buildQuestion('kpis', model, recommended!)];
        } else if (slots.charts === null) {
          questions = [buildQuestion('charts', model, recommended!)];
        }
      }

      return {
        slots,
        questions,
        ready: slotsReady(slots),
        warnings: [...new Set(warnings)],
        confirmed: [slots.model, slots.slicers, slots.kpis, slots.charts].filter((v) => v !== null)
          .length,
        debug,
      };
    },

    async generate(input) {
      const slots = normalizeSlots(input.slots);
      const model = input.models.find((m) => m.name === slots.model);
      if (!model) throw new Error('请先选择要连接的数据模型');

      const warnings: string[] = [];
      const debug: AgentDebugEntry[] = [];
      const fallbackName = deriveName(input.prompt, model.name);
      const fallback = sanitizeSpec(
        {
          name: fallbackName,
          slicers: slots.slicers ?? [],
          kpis: slots.kpis ?? [],
          charts: slots.charts ?? [],
        },
        model.columns,
        fallbackName,
      );

      if (input.cfg.apiKey) {
        let lastError = '';
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const messages = buildGeneratePrompt({ model, prompt: input.prompt, slots });
          const entry: AgentDebugEntry = { stage: 'generate', model: model.name, messages };
          try {
            const raw = await callLlm(input.cfg, messages);
            entry.response = raw;
            const parsed = sanitizeSpec(parseJsonObject(raw), model.columns, fallbackName);
            // 大模型漏掉已确认的对象时不可接受，直接回退到本地模板
            const lostSlicers = (slots.slicers?.length ?? 0) > parsed.spec.slicers.length;
            const lostKpis = (slots.kpis?.length ?? 0) > parsed.spec.kpis.length;
            const lostCharts = (slots.charts?.length ?? 0) > parsed.spec.charts.length;
            if (lostSlicers || lostKpis || lostCharts) {
              lastError = '模型返回的结构缺少已确认的对象';
              break;
            }
            return {
              spec: parsed.spec,
              warnings: [...parsed.warnings],
              source: 'llm',
              debug: [...debug, entry],
            };
          } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
            lastError = entry.error;
          } finally {
            debug.push(entry);
          }
        }
        if (lastError) warnings.push(`大模型生成失败（${lastError}），已改用本地模板`);
      }

      return {
        spec: fallback.spec,
        warnings: [...warnings, ...fallback.warnings],
        source: 'template',
        debug,
      };
    },
  };
}

/** 生成阶段前的字段可见性检查（提示词只送列名与类型，不送明细数据） */
export function assertModelUsable(model: AgentModel): void {
  if (model.columns.length === 0) throw new Error('该数据模型没有可用字段');
}

export { logicalTypeOf, resolveField };
