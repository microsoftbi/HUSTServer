import { describe, expect, it } from 'vitest';
import {
  clearSlicerState,
  dateBounds,
  defaultSlicer,
  defaultSlicerFor,
  defaultSlicerState,
  distinctValues,
  formatDateLabel,
  numericBounds,
  relativeRange,
  selectAllValues,
  setSlicerRange,
  slicerActive,
  slicerFilters,
  slicerOf,
  toggleSlicerValue,
} from '../src/features/dashboard/lib/slicer.js';
import type { ChartWidget, Dataset, SlicerConfig } from '../src/features/dashboard/types.js';

const dataset: Dataset = {
  id: 'ds1',
  name: '销售',
  source: 'sql',
  columns: [
    { name: 'province', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'amount', type: 'number' },
    { name: 'date', type: 'date' },
  ],
  rows: [
    ['湖北', '武汉', 10, '2026-01-05'],
    ['湖北', '宜昌', 20, '2026-02-10'],
    ['湖南', '长沙', 30, '2026-03-15'],
    ['湖南', '岳阳', 5, '2026-04-01'],
    ['湖北', '武汉', 100, '2026-05-01'],
    ['湖南', '宜昌', 20, '2026-06-01'],
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  def: { kind: 'model', modelName: 'sales' },
};

function makeWidget(
  patch: Partial<SlicerConfig> = {},
  fields: string[] = ['province'],
): ChartWidget {
  return {
    id: 'w1',
    type: 'filter',
    title: '切片器',
    datasetId: 'ds1',
    encoding: { measures: [] },
    layout: { x: 0, y: 0, w: 260, h: 200 },
    filterFields: fields,
    slicer: { ...defaultSlicer(), ...patch },
  };
}

describe('slicer 配置', () => {
  it('默认配置对齐 Power BI 新建切片器', () => {
    const cfg = defaultSlicer();
    expect(cfg.type).toBe('list');
    expect(cfg.selectionMode).toBe('multi');
    expect(cfg.showSelectAll).toBe(true);
    expect(cfg.searchable).toBe(true);
    expect(cfg.state).toEqual(defaultSlicerState());
  });

  it('旧数据缺少 state 时补齐默认值', () => {
    const widget = {
      ...makeWidget(),
      slicer: { type: 'dropdown' } as unknown as SlicerConfig,
    };
    const cfg = slicerOf(widget);
    expect(cfg.type).toBe('dropdown');
    expect(cfg.state.selections).toEqual({});
    expect(cfg.state.relative).toEqual({ direction: 'last', count: 30, unit: 'day' });
  });

  it('没有 slicer 字段时使用默认配置', () => {
    const widget = makeWidget();
    delete widget.slicer;
    expect(slicerOf(widget).type).toBe('list');
  });
});

describe('distinctValues', () => {
  it('文本按中文排序', () => {
    expect(distinctValues(dataset, 'province')).toEqual(['湖北', '湖南']);
  });

  it('数值按大小排序', () => {
    expect(distinctValues(dataset, 'amount')).toEqual(['5', '10', '20', '30', '100']);
  });

  it('日期按时间先后排序', () => {
    expect(distinctValues(dataset, 'date')).toEqual([
      '2026-01-05',
      '2026-02-10',
      '2026-03-15',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
    ]);
  });

  it('未知字段返回空数组', () => {
    expect(distinctValues(dataset, 'unknown')).toEqual([]);
  });

  it('数值区间边界', () => {
    expect(numericBounds(dataset, 'amount')).toEqual({ min: 5, max: 100 });
    expect(numericBounds(dataset, 'province')).toBeNull();
  });
});

describe('选择状态', () => {
  it('单选：替换与再次点击取消', () => {
    const state = defaultSlicerState();
    const a = toggleSlicerValue(state, 'province', '湖北', 'single', false);
    expect(a.selections.province).toEqual(['湖北']);
    const b = toggleSlicerValue(a, 'province', '湖南', 'single', false);
    expect(b.selections.province).toEqual(['湖南']);
    const c = toggleSlicerValue(b, 'province', '湖南', 'single', false);
    expect(c.selections.province).toBeUndefined();
  });

  it('多选：⌘/Ctrl 累加，非累加则替换', () => {
    const state = defaultSlicerState();
    const a = toggleSlicerValue(state, 'province', '湖北', 'multi', false);
    expect(a.selections.province).toEqual(['湖北']);
    const b = toggleSlicerValue(a, 'province', '湖南', 'multi', true);
    expect(b.selections.province).toEqual(['湖北', '湖南']);
    const c = toggleSlicerValue(b, 'province', '湖北', 'multi', true);
    expect(c.selections.province).toEqual(['湖南']);
    const d = toggleSlicerValue(c, 'province', '湖北', 'multi', false);
    expect(d.selections.province).toEqual(['湖北']);
  });

  it('全选等价于清空该字段筛选', () => {
    const state = toggleSlicerValue(
      defaultSlicerState(),
      'province',
      '湖北',
      'multi',
      false,
    );
    expect(selectAllValues(state, 'province').selections.province).toBeUndefined();
  });

  it('清除筛选会同时清空选中与区间', () => {
    let state = toggleSlicerValue(
      defaultSlicerState(),
      'province',
      '湖北',
      'multi',
      false,
    );
    state = setSlicerRange(state, 'amount', { min: '10', max: '20' });
    const cleared = clearSlicerState(state);
    expect(cleared.selections).toEqual({});
    expect(cleared.ranges).toEqual({});
  });
});

describe('relativeRange', () => {
  const now = new Date(2026, 9, 21, 15, 30);

  it('过去 7 天包含当天', () => {
    const { from, to } = relativeRange({ direction: 'last', count: 7, unit: 'day' }, now);
    expect(new Date(from).getDate()).toBe(15);
    expect(new Date(from).getMonth()).toBe(9);
    expect(new Date(to).getDate()).toBe(21);
    expect(new Date(to).getHours()).toBe(23);
  });

  it('接下来 7 天从当天开始', () => {
    const { from, to } = relativeRange({ direction: 'next', count: 7, unit: 'day' }, now);
    expect(new Date(from).getDate()).toBe(21);
    expect(new Date(to).getDate()).toBe(27);
  });

  it('过去 2 个月从两个月前的月初开始', () => {
    const { from } = relativeRange({ direction: 'last', count: 2, unit: 'month' }, now);
    expect(new Date(from).getMonth()).toBe(7);
    expect(new Date(from).getDate()).toBe(1);
  });
});

describe('slicerFilters', () => {
  it('列表切片器生成多值条件', () => {
    const widget = makeWidget({
      state: { ...defaultSlicerState(), selections: { province: ['湖北', '湖南'] } },
    });
    expect(slicerFilters(widget, dataset)).toEqual([
      { kind: 'values', field: 'province', values: ['湖北', '湖南'] },
    ]);
  });

  it('未选择时不生成条件', () => {
    expect(slicerFilters(makeWidget(), dataset)).toEqual([]);
  });

  it('介于（数值列）生成数值区间', () => {
    const widget = makeWidget({
      type: 'between',
      state: {
        ...defaultSlicerState(),
        ranges: { amount: { min: '10', max: '30' } },
      },
      // fields 默认 province，这里改用数值列
    }, ['amount']);
    expect(slicerFilters(widget, dataset)).toEqual([
      { kind: 'range', field: 'amount', min: 10, max: 30 },
    ]);
  });

  it('之前 / 之后只生成单侧边界', () => {
    const before = makeWidget(
      {
        type: 'before',
        state: { ...defaultSlicerState(), ranges: { amount: { max: '20' } } },
      },
      ['amount'],
    );
    expect(slicerFilters(before, dataset)).toEqual([
      { kind: 'range', field: 'amount', min: undefined, max: 20 },
    ]);

    const after = makeWidget(
      {
        type: 'after',
        state: { ...defaultSlicerState(), ranges: { amount: { min: '20' } } },
      },
      ['amount'],
    );
    expect(slicerFilters(after, dataset)).toEqual([
      { kind: 'range', field: 'amount', min: 20, max: undefined },
    ]);
  });

  it('介于（日期列）生成日期区间', () => {
    const widget = makeWidget(
      {
        type: 'between',
        state: {
          ...defaultSlicerState(),
          ranges: { date: { min: '2026-02-01', max: '2026-03-31' } },
        },
      },
      ['date'],
    );
    const [cond] = slicerFilters(widget, dataset);
    expect(cond.kind).toBe('dateRange');
    if (cond.kind === 'dateRange') {
      expect(new Date(cond.from!).getMonth()).toBe(1);
      // 仅含日期的上限按整天处理
      expect(cond.to).toBe(Date.parse('2026-03-31') + 86_399_999);
    }
  });

  it('相对日期切片器生成日期区间', () => {
    const now = new Date(2026, 9, 21, 15, 30);
    const widget = makeWidget(
      { type: 'relativeDate' },
      ['date'],
    );
    const [cond] = slicerFilters(widget, dataset, now);
    expect(cond.kind).toBe('dateRange');
  });

  it('层次结构切片器按层级生成多个 AND 条件', () => {
    const widget = makeWidget(
      {
        type: 'hierarchy',
        state: {
          ...defaultSlicerState(),
          selections: { province: ['湖北'], city: ['武汉'] },
        },
      },
      ['province', 'city'],
    );
    expect(slicerFilters(widget, dataset)).toEqual([
      { kind: 'values', field: 'province', values: ['湖北'] },
      { kind: 'values', field: 'city', values: ['武汉'] },
    ]);
  });
});

describe('日期支持（对齐 Power BI）', () => {
  it('零时刻 ISO 展示为短日期', () => {
    expect(formatDateLabel('2010-12-29T00:00:00.000Z')).toBe('2010-12-29');
    expect(formatDateLabel('2010-12-29T00:00:00Z')).toBe('2010-12-29');
    expect(formatDateLabel('2026-01-05')).toBe('2026-01-05');
    expect(formatDateLabel('(空)')).toBe('(空)');
  });

  it('非零时刻保留时分', () => {
    const label = formatDateLabel(new Date(2026, 0, 5, 9, 30).toISOString());
    expect(label).toBe('2026-01-05 09:30');
  });

  it('日期列默认「介于」区间切片器，其它列仍为列表', () => {
    expect(defaultSlicerFor('date').type).toBe('between');
    expect(defaultSlicerFor('string').type).toBe('list');
    expect(defaultSlicerFor('number').type).toBe('list');
  });

  it('dateBounds 取日期列的最小 / 最大日期', () => {
    const bounds = dateBounds(dataset, 'date');
    expect(bounds?.minLabel).toBe('2026-01-05');
    expect(bounds?.maxLabel).toBe('2026-06-01');
    expect(dateBounds(dataset, 'amount')).toBeNull();
  });

  it('相对日期可关闭，关闭后不生成筛选', () => {
    const widget = makeWidget(
      {
        type: 'relativeDate',
        state: {
          ...defaultSlicerState(),
          relative: { direction: 'last', count: 7, unit: 'day', enabled: false },
        },
      },
      ['date'],
    );
    expect(slicerFilters(widget, dataset)).toEqual([]);
    expect(slicerActive(slicerOf(widget), ['date'])).toBe(false);
  });

  it('清除筛选会关闭相对日期', () => {
    const cleared = clearSlicerState(defaultSlicerState());
    expect(cleared.relative.enabled).toBe(false);
  });
});

describe('slicerActive', () => {
  it('有选择或有区间时视为启用', () => {
    const fields = ['province'];
    expect(slicerActive(defaultSlicer(), fields)).toBe(false);
    expect(
      slicerActive(
        { ...defaultSlicer(), state: { ...defaultSlicerState(), selections: { province: ['湖北'] } } },
        fields,
      ),
    ).toBe(true);
    expect(
      slicerActive(
        {
          ...defaultSlicer(),
          type: 'between',
          state: { ...defaultSlicerState(), ranges: { province: { min: '1' } } },
        },
        fields,
      ),
    ).toBe(true);
  });

  it('没有字段时视为未启用', () => {
    expect(slicerActive(defaultSlicer(), [])).toBe(false);
  });
});
