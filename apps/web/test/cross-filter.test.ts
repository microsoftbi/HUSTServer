import { describe, expect, it } from 'vitest';
import { filterDataset } from '../src/features/dashboard/lib/highlight.js';
import { aggregate } from '../src/features/dashboard/lib/aggregate.js';
import type { Dataset } from '../src/features/dashboard/types.js';

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

describe('filterDataset', () => {
  it('按选中值过滤行', () => {
    const filtered = filterDataset(dataset, { field: 'province', values: ['湖北'] });
    expect(filtered.rows).toEqual([
      ['湖北', '武汉', 10],
      ['湖北', '宜昌', 20],
    ]);
    // 原数据集不被修改
    expect(dataset.rows).toHaveLength(4);
  });

  it('支持多选值', () => {
    const filtered = filterDataset(dataset, {
      field: 'city',
      values: ['武汉', '长沙'],
    });
    expect(filtered.rows).toHaveLength(2);
  });

  it('空值按「(空)」匹配', () => {
    const filtered = filterDataset(dataset, { field: 'city', values: ['(空)'] });
    expect(filtered.rows).toEqual([['湖南', '', 5]]);
  });

  it('字段不存在或条件为空时原样返回', () => {
    expect(filterDataset(dataset, { field: 'unknown', values: ['x'] })).toBe(dataset);
    expect(filterDataset(dataset, null)).toBe(dataset);
    expect(filterDataset(dataset, { field: 'province', values: [] })).toBe(dataset);
  });

  it('无命中时返回空行集', () => {
    const filtered = filterDataset(dataset, { field: 'province', values: ['广东'] });
    expect(filtered.rows).toHaveLength(0);
  });
});

describe('跨维度联动', () => {
  it('按省份选中后，按城市分组的图表只保留对应城市并重算', () => {
    const filtered = filterDataset(dataset, { field: 'province', values: ['湖北'] });
    const agg = aggregate(filtered, {
      dimension: 'city',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(agg.data).toEqual([
      { city: '武汉', 'sum(amount)': 10 },
      { city: '宜昌', 'sum(amount)': 20 },
    ]);
  });

  it('按城市选中后，按省份分组的图表重算为单值', () => {
    const filtered = filterDataset(dataset, { field: 'city', values: ['宜昌'] });
    const agg = aggregate(filtered, {
      dimension: 'province',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(agg.data).toEqual([{ province: '湖北', 'sum(amount)': 20 }]);
  });
});
