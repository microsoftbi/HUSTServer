import { describe, expect, it } from 'vitest';
import {
  hasPlaceholder,
  placeholderExpressions,
  resolveTitleTemplate,
  titleFormatOf,
  titleValues,
} from '../src/features/dashboard/lib/title.js';
import type { Dataset } from '../src/features/dashboard/types.js';

function dataset(): Dataset {
  return {
    id: 'ds1',
    name: '销售',
    source: 'csv',
    createdAt: '2026-01-01T00:00:00.000Z',
    def: { kind: 'model', modelName: 'sales' },
    columns: [
      { name: '地区', type: 'string' },
      { name: '金额', type: 'number' },
      { name: '数量', type: 'number' },
    ],
    rows: [
      ['华东', 100, 2],
      ['华南', 200, 3],
      ['华北', 50, 1],
    ],
    formats: {
      金额: { decimals: 0, thousands: true, unit: 'none' },
    },
    measures: {
      m1: { id: 'm1', name: '客单价', expression: 'SUM([金额]) / SUM([数量])' },
      m2: {
        id: 'm2',
        name: '本月销售额',
        expression: 'SUM([金额])',
        format: { decimals: 0, thousands: true, unit: 'tenThousand' },
      },
    },
  };
}

describe('占位符解析', () => {
  it('识别是否含占位符', () => {
    expect(hasPlaceholder('本月销售额 {sum(金额)}')).toBe(true);
    expect(hasPlaceholder('本月销售额')).toBe(false);
  });

  it('抽取表达式并去重', () => {
    expect(placeholderExpressions('{sum(金额)} / {客单价} / {sum(金额)}')).toEqual([
      'sum(金额)',
      '客单价',
    ]);
  });
});

describe('titleValues', () => {
  it('计算基础聚合表达式', () => {
    const values = titleValues('{sum(金额)}', dataset());
    expect(values['sum(金额)']).toBe(350);
  });

  it('计算命名度量（比率）', () => {
    const values = titleValues('{客单价}', dataset());
    expect(values['客单价']).toBeCloseTo(350 / 6);
  });

  it('按筛选条件计算', () => {
    const values = titleValues('{sum(金额)}', dataset(), [
      { kind: 'values', field: '地区', values: ['华东'] },
    ]);
    expect(values['sum(金额)']).toBe(100);
  });

  it('无法计算的表达式返回 null', () => {
    const values = titleValues('{sum(不存在)}', dataset());
    expect(values['sum(不存在)']).toBeNull();
  });
});

describe('resolveTitleTemplate', () => {
  it('替换为格式化后的数值', () => {
    const ds = dataset();
    const text = resolveTitleTemplate(
      '本月销售额 {sum(金额)}',
      titleValues('本月销售额 {sum(金额)}', ds),
      (expr) => titleFormatOf(expr, ds),
    );
    expect(text).toBe('本月销售额 350');
  });

  it('命名度量的显示单位生效', () => {
    const ds = dataset();
    const text = resolveTitleTemplate(
      '{本月销售额}',
      titleValues('{本月销售额}', ds),
      (expr) => titleFormatOf(expr, ds),
    );
    // 350 按「万」单位折算：0.035 → 保留 0 位小数 → 0万
    expect(text).toBe('0万');
  });

  it('空值显示占位符', () => {
    const ds = dataset();
    const text = resolveTitleTemplate(
      '缺失 {sum(不存在)}',
      titleValues('缺失 {sum(不存在)}', ds),
      (expr) => titleFormatOf(expr, ds),
    );
    expect(text).toBe('缺失 —');
  });
});
