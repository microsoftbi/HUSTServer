import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONDITIONAL,
  cellDecor,
  appliesTo,
  chartFill,
  mixHex,
  rangeOf,
  ratioOf,
  ruleHit,
} from '../src/features/dashboard/lib/conditional.js';
import { formatNumber } from '../src/features/dashboard/lib/format.js';
import type { ConditionalFormat } from '../src/features/dashboard/types.js';

function cfg(patch: Partial<ConditionalFormat> = {}): ConditionalFormat {
  return { ...DEFAULT_CONDITIONAL, mode: 'dataBar', ...patch };
}

describe('rangeOf', () => {
  it('忽略空值并给出最小值 / 最大值 / 均值 / 中位数', () => {
    const range = rangeOf([10, null, 30, 20, -10]);
    expect(range).not.toBeNull();
    expect(range?.min).toBe(-10);
    expect(range?.max).toBe(30);
    expect(range?.avg).toBe(12.5);
    expect(range?.median).toBe(15);
  });

  it('全空时返回 null', () => {
    expect(rangeOf([null, null])).toBeNull();
  });

  it('偶数个值时中位数为中间两个的平均', () => {
    expect(rangeOf([1, 2, 3, 4])?.median).toBe(2.5);
  });
});

describe('ratioOf', () => {
  it('按区间归一化并夹紧到 0-1', () => {
    const range = { min: 0, max: 100, avg: 50, median: 50 };
    expect(ratioOf(0, range)).toBe(0);
    expect(ratioOf(50, range)).toBe(0.5);
    expect(ratioOf(120, range)).toBe(1);
  });

  it('区间退化为单点时返回 1', () => {
    expect(ratioOf(5, { min: 5, max: 5, avg: 5, median: 5 })).toBe(1);
  });
});

describe('mixHex', () => {
  it('两端返回原色，中点取中间值', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('cellDecor', () => {
  const range = rangeOf([10, 20, 30]);

  it('数据条给出 0-1 比例', () => {
    const d = cellDecor(20, range, cfg({ mode: 'dataBar' }));
    expect(d?.bar?.ratio).toBeCloseTo(0.5);
  });

  it('色阶按值返回背景色（三色在两端分别取最小 / 最大色）', () => {
    const c = cfg({ mode: 'colorScale', threeColor: true });
    expect(cellDecor(10, range, c)?.background).toBe(c.minColor);
    expect(cellDecor(30, range, c)?.background).toBe(c.maxColor);
  });

  it('图标按三等分给出上 / 中 / 下', () => {
    const c = cfg({ mode: 'iconSet' });
    expect(cellDecor(10, range, c)?.icon).toBe('down');
    expect(cellDecor(20, range, c)?.icon).toBe('flat');
    expect(cellDecor(30, range, c)?.icon).toBe('up');
  });

  it('非数值返回 null', () => {
    expect(cellDecor('武汉', range, cfg())).toBeNull();
    expect(cellDecor(null, range, cfg())).toBeNull();
  });
});

describe('ruleHit', () => {
  const range = rangeOf([10, 20, 30]);

  it('固定阈值比较', () => {
    expect(
      ruleHit(25, { id: 'r', operator: 'gt', threshold: 'value', value: 20 }, range!),
    ).toBe(true);
    expect(
      ruleHit(20, { id: 'r', operator: 'gt', threshold: 'value', value: 20 }, range!),
    ).toBe(false);
    expect(
      ruleHit(20, { id: 'r', operator: 'gte', threshold: 'value', value: 20 }, range!),
    ).toBe(true);
  });

  it('动态阈值使用列统计量', () => {
    expect(
      ruleHit(30, { id: 'r', operator: 'gt', threshold: 'avg' }, range!),
    ).toBe(true);
    expect(
      ruleHit(10, { id: 'r', operator: 'lt', threshold: 'avg' }, range!),
    ).toBe(true);
  });
});

describe('rules 模式', () => {
  const range = rangeOf([10, 20, 30]);

  it('命中第一条规则即止并返回样式', () => {
    const c = cfg({
      mode: 'rules',
      rules: [
        {
          id: 'hi',
          operator: 'gte',
          threshold: 'value',
          value: 30,
          background: '#fee2e2',
          color: '#991b1b',
          bold: true,
        },
        {
          id: 'low',
          operator: 'lte',
          threshold: 'value',
          value: 10,
          background: '#dcfce7',
        },
      ],
    });
    const high = cellDecor(30, range, c);
    expect(high?.background).toBe('#fee2e2');
    expect(high?.color).toBe('#991b1b');
    expect(high?.bold).toBe(true);

    expect(cellDecor(10, range, c)?.background).toBe('#dcfce7');
    expect(cellDecor(20, range, c)).toBeNull();
  });
});

describe('appliesTo / chartFill', () => {
  it('空 fields 表示作用于全部数值列', () => {
    expect(appliesTo(cfg(), 'sum(amount)')).toBe(true);
    expect(appliesTo(cfg({ fields: ['sum(amount)'] }), 'sum(qty)')).toBe(false);
  });

  it('柱形图着色：色阶与规则命中返回颜色，其他模式不覆盖', () => {
    const range = rangeOf([10, 20, 30]);
    const scale = cfg({ mode: 'colorScale', threeColor: false });
    expect(chartFill(30, range, scale)).toBe(scale.maxColor);
    expect(chartFill(20, range, cfg({ mode: 'dataBar' }))).toBeUndefined();

    const rules = cfg({
      mode: 'rules',
      rules: [
        {
          id: 'r',
          operator: 'gt',
          threshold: 'value',
          value: 25,
          background: '#fecaca',
        },
      ],
    });
    expect(chartFill(30, range, rules)).toBe('#fecaca');
    expect(chartFill(20, range, rules)).toBeUndefined();
  });
});

describe('formatNumber percent', () => {
  it('百分比先乘 100 再追加 %', () => {
    expect(
      formatNumber(0.125, { decimals: 1, thousands: false, unit: 'none', percent: true }),
    ).toBe('12.5%');
    expect(
      formatNumber(0.1234, { decimals: -1, thousands: false, unit: 'none', percent: true }),
    ).toBe('12.34%');
  });
});
