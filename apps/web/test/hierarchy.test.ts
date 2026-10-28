import { describe, expect, it } from 'vitest';
import {
  aggregate,
  axisFields,
  effectiveDimensions,
  hierarchyFields,
  LEVEL_SEP,
} from '../src/features/dashboard/lib/aggregate.js';
import { drillValueFilters } from '../src/features/dashboard/lib/highlight.js';
import type { ChartWidget, Dataset } from '../src/features/dashboard/types.js';

const dataset: Dataset = {
  id: 'ds1',
  name: '销售',
  source: 'sql',
  columns: [
    { name: 'province', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'amount', type: 'number' },
  ],
  rows: [
    ['湖北', '武汉', 10],
    ['湖北', '宜昌', 20],
    ['湖南', '长沙', 30],
    ['湖南', '', 5],
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  def: { kind: 'model', modelName: 'sales' },
};

const encoding = {
  dimension: 'province',
  extraDimensions: ['city'],
  measures: [{ field: 'amount', agg: 'sum' as const }],
};

describe('X 轴多字段自动成层', () => {
  it('axisFields 按拖入顺序返回层级', () => {
    expect(axisFields(encoding)).toEqual(['province', 'city']);
    expect(axisFields({ measures: [] })).toEqual([]);
  });

  it('未下钻时展示全部轴字段', () => {
    expect(effectiveDimensions(encoding)).toEqual(['province', 'city']);
    expect(effectiveDimensions(encoding, { path: [], level: 0, selections: [] })).toEqual([
      'province',
      'city',
    ]);
  });

  it('钻取模式只显示当前层，展开模式显示 0…level 各层', () => {
    const drill = { path: ['city'], level: 1, selections: ['湖北'] };
    expect(hierarchyFields(encoding, drill)).toEqual(['province', 'city']);
    expect(effectiveDimensions(encoding, drill)).toEqual(['city']);

    const expanded = { ...drill, mode: 'expand' as const };
    expect(effectiveDimensions(encoding, expanded)).toEqual(['province', 'city']);
  });

  it('钻取井字段接在轴字段之后，且与轴字段去重', () => {
    const drill = {
      path: ['city', 'amount'],
      level: 2,
      selections: ['湖北', '武汉'],
      mode: 'expand' as const,
    };
    expect(hierarchyFields(encoding, drill)).toEqual(['province', 'city', 'amount']);
  });

  it('多级聚合生成「父 / 子」标签并保留各层原始值', () => {
    const agg = aggregate(dataset, encoding, ['province', 'city']);
    expect(agg.dimensionKey).toBe(`province${LEVEL_SEP}city`);
    expect(agg.data).toEqual([
      { [`province${LEVEL_SEP}city`]: `湖北${LEVEL_SEP}武汉`, 'sum(amount)': 10 },
      { [`province${LEVEL_SEP}city`]: `湖北${LEVEL_SEP}宜昌`, 'sum(amount)': 20 },
      { [`province${LEVEL_SEP}city`]: `湖南${LEVEL_SEP}长沙`, 'sum(amount)': 30 },
      { [`province${LEVEL_SEP}city`]: `湖南${LEVEL_SEP}(空)`, 'sum(amount)': 5 },
    ]);
    expect(agg.dimensionPaths?.[`湖南${LEVEL_SEP}长沙`]).toEqual(['湖南', '长沙']);
  });
});

describe('层级下钻筛选', () => {
  const widget = {
    id: 'w1',
    type: 'bar',
    encoding,
    drill: { path: ['city'], level: 1, selections: ['湖北'] },
  } as unknown as ChartWidget;

  it('按完整层级的已选项过滤（轴字段参与）', () => {
    expect(drillValueFilters(widget)).toEqual([
      { kind: 'values', field: 'province', values: ['湖北'] },
    ]);
  });

  it('展开多层时只取当前层之前的选项', () => {
    const expanded = {
      ...widget,
      drill: { ...widget.drill!, mode: 'expand' as const },
    } as ChartWidget;
    expect(drillValueFilters(expanded)).toEqual([
      { kind: 'values', field: 'province', values: ['湖北'] },
    ]);
  });
});
