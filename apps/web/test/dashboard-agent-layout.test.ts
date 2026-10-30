import { describe, expect, it } from 'vitest';
import {
  AGENT_CHART_SIZE,
  AGENT_GAP,
  AGENT_KPI_SIZE,
  AGENT_MARGIN,
  AGENT_SLICER_SIZE,
  bottomOf,
  layoutSpec,
  slicerHeight,
} from '../src/features/dashboard/agent/layout.js';
import { buildWidgets } from '../src/features/dashboard/agent/apply.js';
import type { DashboardSpec } from '../src/features/dashboard/agent/types.js';
import type { Column, WidgetLayout } from '../src/features/dashboard/types.js';

const columns: Column[] = [
  { name: 'country', type: 'string' },
  { name: 'order_date', type: 'date' },
  { name: 'amount', type: 'number' },
];

function spec(overrides: Partial<DashboardSpec> = {}): DashboardSpec {
  return {
    name: '销售分析',
    slicers: [{ field: 'country', type: 'dropdown' }],
    kpis: [{ title: '总销售额', field: 'amount', agg: 'sum' }],
    charts: [
      { type: 'bar', title: '各国销量', dimension: 'country', measures: [{ field: 'amount', agg: 'sum' }] },
    ],
    ...overrides,
  };
}

function widget(layout: WidgetLayout) {
  return { layout };
}

describe('layoutSpec（生成结果的本地排布）', () => {
  it('空画布从页边距开始', () => {
    const out = layoutSpec(spec());
    expect(out.slicers[0]).toMatchObject({ x: AGENT_MARGIN, y: AGENT_MARGIN });
  });

  it('已有对象时排到最下边缘下方一个间距', () => {
    const occupied = [widget({ x: 24, y: 24, w: 400, h: 300 })];
    expect(bottomOf(occupied)).toBe(324);
    const out = layoutSpec(spec(), occupied);
    expect(out.slicers[0].y).toBe(324 + AGENT_GAP);
    // 数据卡片排在切片器区块下方（下拉切片器用矮卡片高度）
    expect(out.kpis[0].y).toBe(324 + AGENT_GAP + slicerHeight('dropdown') + AGENT_GAP);
  });

  it('切片器高度按控件形态取值：下拉更矮，列表保持默认高度', () => {
    expect(slicerHeight('dropdown')).toBeLessThan(AGENT_SLICER_SIZE.h);
    expect(slicerHeight('list')).toBe(AGENT_SLICER_SIZE.h);
    const out = layoutSpec(
      spec({
        slicers: [
          { field: 'country', type: 'dropdown' },
          { field: 'order_date', type: 'between' },
        ],
      }),
    );
    // 同一行按最高项对齐，数据卡片从最高的「介于」下方开始
    expect(out.slicers[0].y).toBe(out.slicers[1].y);
    expect(out.slicers[0].h).toBe(slicerHeight('dropdown'));
    expect(out.slicers[1].h).toBe(slicerHeight('between'));
    expect(out.kpis[0].y).toBe(AGENT_MARGIN + slicerHeight('between') + AGENT_GAP);
  });

  it('切片器在 1280 宽下每行 4 个，超出换行', () => {
    const out = layoutSpec(
      spec({
        slicers: Array.from({ length: 5 }, (_, i) => ({ field: `f${i}`, type: 'dropdown' as const })),
      }),
    );
    expect(out.slicers).toHaveLength(5);
    // 第 1 行
    expect(out.slicers[2]).toMatchObject({
      x: AGENT_MARGIN + 2 * (AGENT_SLICER_SIZE.w + AGENT_GAP),
      y: AGENT_MARGIN,
    });
    // 第 2 行第 1 个
    expect(out.slicers[4]).toMatchObject({
      x: AGENT_MARGIN,
      y: AGENT_MARGIN + slicerHeight('dropdown') + AGENT_GAP,
    });
  });

  it('数据卡片平铺成一行，图表排在其下方且每行 2 个', () => {
    const out = layoutSpec(
      spec({
        slicers: [],
        kpis: Array.from({ length: 3 }, (_, i) => ({ title: `k${i}`, field: 'amount', agg: 'sum' as const })),
        charts: [
          { type: 'bar', title: 'a', dimension: 'country', measures: [{ field: 'amount', agg: 'sum' }] },
          { type: 'line', title: 'b', dimension: 'order_date', measures: [{ field: 'amount', agg: 'sum' }] },
          { type: 'pie', title: 'c', dimension: 'country', measures: [{ field: 'amount', agg: 'sum' }] },
        ],
      }),
    );
    // 没有切片器：3 张卡片同一行、从顶部开始
    expect(out.kpis.map((k) => k.y)).toEqual([AGENT_MARGIN, AGENT_MARGIN, AGENT_MARGIN]);
    // 等宽：可用宽度扣掉间距后三等分
    const usable = 1280 - AGENT_MARGIN * 2;
    const w = Math.floor((usable - 2 * AGENT_GAP) / 3);
    expect(out.kpis.map((k) => k.w)).toEqual([w, w, w]);
    expect(out.kpis[1].x).toBe(AGENT_MARGIN + w + AGENT_GAP);
    // 高度是常规卡片的一半
    expect(out.kpis[0].h).toBe(70);
    // 图表排在卡片这一行下方，每行 2 个
    const kpiBottom = AGENT_MARGIN + AGENT_KPI_SIZE.h + AGENT_GAP;
    expect(out.charts[0].y).toBe(kpiBottom);
    expect(out.charts[2].y).toBe(kpiBottom + AGENT_CHART_SIZE.h + AGENT_GAP);
  });

  it('空规格不产生任何视觉对象', () => {
    const out = layoutSpec({ name: '空', slicers: [], kpis: [], charts: [] });
    expect(out.slicers).toHaveLength(0);
    expect(out.kpis).toHaveLength(0);
    expect(out.charts).toHaveLength(0);
  });
});

describe('buildWidgets（规格 → 视觉对象）', () => {
  it('切片器按字段类型取默认样式，日期字段落成「介于」', () => {
    const widgets = buildWidgets(
      spec({ slicers: [{ field: 'order_date', type: 'between' }, { field: 'country' }] }),
      'ds1',
      columns,
    );
    const [date, text] = widgets;
    expect(date.type).toBe('filter');
    expect(date.filterFields).toEqual(['order_date']);
    expect(date.slicer?.type).toBe('between');
    // 文本字段没有指定类型时退回默认「列表」
    expect(text.slicer?.type).toBe('list');
  });

  it('数据卡片与图表的字段 / 聚合原样落到 encoding', () => {
    const widgets = buildWidgets(spec(), 'ds1', columns);
    const kpi = widgets.find((w) => w.type === 'kpi')!;
    expect(kpi.title).toBe('总销售额');
    expect(kpi.encoding.measures).toEqual([{ field: 'amount', agg: 'sum' }]);
    const bar = widgets.find((w) => w.type === 'bar')!;
    expect(bar.encoding.dimension).toBe('country');
    expect(bar.encoding.measures).toEqual([{ field: 'amount', agg: 'sum' }]);
    expect(widgets.every((w) => w.datasetId === 'ds1')).toBe(true);
  });

  it('未知图表类型回退为柱形图', () => {
    const widgets = buildWidgets(
      spec({
        slicers: [],
        kpis: [],
        charts: [
          { type: 'radar', title: '雷达', dimension: 'country', measures: [{ field: 'amount', agg: 'sum' }] },
        ],
      }),
      'ds1',
      columns,
    );
    expect(widgets[0].type).toBe('bar');
  });

  it('追加到已有对象下方，坐标取自 layoutSpec', () => {
    const occupied = [widget({ x: 24, y: 24, w: 400, h: 200 })];
    const widgets = buildWidgets(spec(), 'ds1', columns, occupied);
    const expected = layoutSpec(spec(), occupied);
    expect(widgets.find((w) => w.type === 'filter')!.layout).toEqual(expected.slicers[0]);
    expect(widgets.find((w) => w.type === 'kpi')!.layout).toEqual(expected.kpis[0]);
    expect(widgets.find((w) => w.type === 'bar')!.layout).toEqual(expected.charts[0]);
  });
});
