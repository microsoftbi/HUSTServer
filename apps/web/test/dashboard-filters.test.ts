import { describe, expect, it } from 'vitest';
import { applyValueFilters } from '../src/features/dashboard/lib/highlight.js';
import { aggregate } from '../src/features/dashboard/lib/aggregate.js';
import type { CellValue, Dataset } from '../src/features/dashboard/types.js';

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
    ['湖南', '', 5, ''],
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  def: { kind: 'model', modelName: 'sales' },
};

describe('applyValueFilters', () => {
  it('单个值按值保留行', () => {
    const filtered = applyValueFilters(dataset, [
      { kind: 'values', field: 'province', values: ['湖北'] },
    ]);
    expect(filtered.rows).toEqual([
      ['湖北', '武汉', 10, '2026-01-05'],
      ['湖北', '宜昌', 20, '2026-02-10'],
    ]);
    expect(dataset.rows).toHaveLength(4);
  });

  it('多值筛选按 IN 语义保留行', () => {
    const filtered = applyValueFilters(dataset, [
      { kind: 'values', field: 'city', values: ['武汉', '长沙'] },
    ]);
    expect(filtered.rows.map((r: CellValue[]) => r[1])).toEqual(['武汉', '长沙']);
  });

  it('多个筛选器按 AND 叠加', () => {
    const filtered = applyValueFilters(dataset, [
      { kind: 'values', field: 'province', values: ['湖北'] },
      { kind: 'values', field: 'city', values: ['宜昌'] },
    ]);
    expect(filtered.rows).toEqual([['湖北', '宜昌', 20, '2026-02-10']]);
  });

  it('空值 / 未知字段 / 空数组时原样返回', () => {
    expect(applyValueFilters(dataset, [])).toBe(dataset);
    expect(applyValueFilters(dataset, null)).toBe(dataset);
    expect(
      applyValueFilters(dataset, [{ kind: 'values', field: 'province', values: [] }]),
    ).toBe(dataset);
    expect(
      applyValueFilters(dataset, [
        { kind: 'values', field: 'unknown', values: ['x'] },
      ]),
    ).toBe(dataset);
  });

  it('数值区间筛选（介于/之前/之后）', () => {
    const between = applyValueFilters(dataset, [
      { kind: 'range', field: 'amount', min: 10, max: 20 },
    ]);
    expect(between.rows.map((r: CellValue[]) => r[2])).toEqual([10, 20]);

    const after = applyValueFilters(dataset, [
      { kind: 'range', field: 'amount', min: 20 },
    ]);
    expect(after.rows.map((r: CellValue[]) => r[2])).toEqual([20, 30]);

    const before = applyValueFilters(dataset, [
      { kind: 'range', field: 'amount', max: 10 },
    ]);
    expect(before.rows.map((r: CellValue[]) => r[2])).toEqual([10, 5]);
  });

  it('日期区间筛选，无法解析日期的行被排除', () => {
    const filtered = applyValueFilters(dataset, [
      {
        kind: 'dateRange',
        field: 'date',
        from: Date.parse('2026-02-01'),
        to: Date.parse('2026-03-31'),
      },
    ]);
    expect(filtered.rows.map((r: CellValue[]) => r[3])).toEqual(['2026-02-10', '2026-03-15']);
  });

  it('筛选后聚合结果随行集重算', () => {
    const filtered = applyValueFilters(dataset, [
      { kind: 'values', field: 'province', values: ['湖南'] },
    ]);
    const agg = aggregate(filtered, {
      dimension: 'city',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(agg.data).toEqual([
      { city: '长沙', 'sum(amount)': 30 },
      { city: '(空)', 'sum(amount)': 5 },
    ]);
  });
});
