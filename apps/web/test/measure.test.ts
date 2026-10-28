import { describe, expect, it } from 'vitest';
import {
  alignPreviousPeriod,
  baseAggKey,
  collectBaseAggs,
  compileMeasure,
  evaluateMeasure,
  measureSqlOf,
  measureToSql,
  periodKeyOf,
  previousPeriodKey,
} from '../src/features/dashboard/lib/measure.js';
import type { NamedMeasure } from '../src/features/dashboard/types.js';

function def(name: string, expression: string): NamedMeasure {
  return { id: name, name, expression };
}

function compiledOf(...defs: NamedMeasure[]) {
  return new Map(defs.map((d) => {
    const cm = compileMeasure(d);
    return [d.name, cm] as const;
  }));
}

describe('compileMeasure', () => {
  it('解析基础聚合并去重', () => {
    const cm = compileMeasure(def('客单价', 'SUM([金额]) / SUM([数量])'));
    expect(cm.error).toBeUndefined();
    expect(cm.bases.map((b) => b.key)).toEqual(['sum(金额)', 'sum(数量)']);
    expect(cm.fields).toEqual(['金额', '数量']);
  });

  it('识别度量引用', () => {
    const cm = compileMeasure(def('占比', 'SUM([金额]) / [总金额]'));
    expect(cm.refs).toEqual(['总金额']);
  });

  it('COUNT(1) 按行计数', () => {
    const cm = compileMeasure(def('行数', 'COUNT(1)'));
    expect(cm.error).toBeUndefined();
    expect(cm.bases).toHaveLength(0);
  });

  it('非法表达式给出可读错误', () => {
    expect(compileMeasure(def('坏', 'SUM([金额]')).error).toBeTruthy();
    expect(compileMeasure(def('坏2', 'FOO([金额])')).error).toContain('未知函数');
  });
});

describe('evaluateMeasure', () => {
  const defs = [def('客单价', 'SUM([金额]) / SUM([数量])'), def('毛利', 'SUM([金额]) - SUM([成本])')];
  const compiled = compiledOf(...defs);

  it('按基础聚合值计算比率', () => {
    const v = evaluateMeasure('客单价', compiled, {
      'sum(金额)': 300,
      'sum(数量)': 3,
    });
    expect(v).toBe(100);
  });

  it('除零返回 null', () => {
    const v = evaluateMeasure('客单价', compiled, {
      'sum(金额)': 300,
      'sum(数量)': 0,
    });
    expect(v).toBeNull();
  });

  it('缺失基础聚合返回 null', () => {
    expect(evaluateMeasure('毛利', compiled, { 'sum(金额)': 100 })).toBeNull();
  });

  it('支持度量互相引用并检测循环', () => {
    const all = compiledOf(
      def('A', '[B] + 1'),
      def('B', '[A] + 1'),
    );
    expect(evaluateMeasure('A', all, {})).toBeNull();
  });

  it('divide() 与普通除法一样处理除零', () => {
    const all = compiledOf(def('比率', 'divide(SUM([金额]), SUM([数量]))'));
    expect(evaluateMeasure('比率', all, { 'sum(金额)': 10, 'sum(数量)': 4 })).toBe(2.5);
    expect(evaluateMeasure('比率', all, { 'sum(金额)': 10, 'sum(数量)': 0 })).toBeNull();
  });
});

describe('SQL 翻译', () => {
  it('基础聚合翻译为带引号的聚合函数', () => {
    const out = measureToSql('SUM([金额]) / SUM([数量])');
    expect(out.sql).toBe('(SUM("金额") / NULLIF(SUM("数量"), 0))');
  });

  it('引用其它度量时递归展开', () => {
    const all = {
      total: def('总金额', 'SUM([金额])'),
      share: def('占比', 'SUM([金额]) / [总金额]'),
    };
    const out = measureSqlOf(all.share, all);
    expect(out.sql).toBe('(SUM("金额") / NULLIF((SUM("金额")), 0))');
  });

  it('未解析的度量返回错误', () => {
    const out = measureToSql('[不存在的度量]');
    expect(out.sql).toBeNull();
    expect(out.error).toContain('无法解析度量');
  });
});

describe('时间对比', () => {
  it('按月份归档并回退一个周期', () => {
    expect(periodKeyOf('2024-03-15', 'mom')).toBe('2024-03');
    expect(periodKeyOf('2024-03-15', 'yoy')).toBe('2024-03');
    expect(previousPeriodKey('2024-03', 'mom')).toBe('2024-02');
    expect(previousPeriodKey('2024-03', 'yoy')).toBe('2023-03');
  });

  it('季度 / 周 / 日归档', () => {
    expect(periodKeyOf('2024-05-01', 'qoq')).toBe('2024-Q2');
    expect(previousPeriodKey('2024-Q2', 'qoq')).toBe('2024-Q1');
    expect(periodKeyOf('2024-03-15', 'dod')).toBe('2024-03-15');
    expect(previousPeriodKey('2024-03-15', 'dod')).toBe('2024-03-14');
  });

  it('对齐上一周期的值', () => {
    const rows = [
      { label: '2024-01', period: '2024-01', value: 10 },
      { label: '2024-02', period: '2024-02', value: 20 },
      { label: '2024-03', period: '2024-03', value: 30 },
    ];
    expect(alignPreviousPeriod(rows, 'mom')).toEqual([null, 10, 20]);
  });

  it('缺失周期返回 null', () => {
    const rows = [
      { label: '2024-01', period: '2024-01', value: 10 },
      { label: '2024-03', period: '2024-03', value: 30 },
    ];
    expect(alignPreviousPeriod(rows, 'mom')).toEqual([null, null]);
  });
});

describe('collectBaseAggs', () => {
  it('多个度量共享的基础聚合只保留一次', () => {
    const a = compileMeasure(def('A', 'SUM([金额]) / SUM([数量])'));
    const b = compileMeasure(def('B', 'SUM([金额]) - SUM([成本])'));
    const bases = collectBaseAggs([a, b]);
    expect(bases.map((x) => x.key)).toEqual([
      baseAggKey('sum', '金额'),
      baseAggKey('sum', '数量'),
      baseAggKey('sum', '成本'),
    ]);
  });
});
