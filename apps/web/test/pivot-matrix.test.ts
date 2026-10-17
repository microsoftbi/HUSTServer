import { describe, expect, it } from 'vitest';
import {
  buildPivotMatrix,
  labelOf,
  mergeLabels,
  type PivotRawResult,
} from '../src/components/pivot/matrix.js';

function raw(partial: Partial<PivotRawResult>): PivotRawResult {
  return {
    rowFields: [],
    columnFields: [],
    values: [{ field: 'amount', agg: 'sum', label: 'sum(amount)' }],
    columns: [],
    rows: [],
    truncated: false,
    totalRows: 0,
    ...partial,
  };
}

describe('labelOf', () => {
  it('空值统一显示 (空)', () => {
    expect(labelOf(null)).toBe('(空)');
    expect(labelOf(undefined)).toBe('(空)');
    expect(labelOf('')).toBe('(空)');
    expect(labelOf(0)).toBe('0');
    expect(labelOf(false)).toBe('false');
  });
});

describe('mergeLabels', () => {
  it('同父级下相邻同标签合并，跨父级不合并', () => {
    const levels = mergeLabels([
      ['2024', 'sum(amount)'],
      ['2024', 'count(amount)'],
      ['2025', 'sum(amount)'],
    ]);
    expect(levels[0]).toEqual([
      { label: '2024', span: 2, covered: false },
      { label: '', span: 0, covered: true },
      { label: '2025', span: 1, covered: false },
    ]);
    expect(levels[1].map((c) => c.label)).toEqual(['sum(amount)', 'count(amount)', 'sum(amount)']);

    // 华北/2024 与 华南/2024：第二层的两个 2024 父级不同，不得合并
    const rows = mergeLabels([['华北', '2024'], ['华南', '2024']]);
    expect(rows[1].every((c) => c.span === 1 && !c.covered)).toBe(true);
  });

  it('单层标签：每个都是独立单元格', () => {
    expect(mergeLabels([['华东'], ['华北'], ['华南']])[0]).toEqual([
      { label: '华东', span: 1, covered: false },
      { label: '华北', span: 1, covered: false },
      { label: '华南', span: 1, covered: false },
    ]);
  });
});

describe('buildPivotMatrix', () => {
  it('行 × 列 × 单度量：拼出矩阵、列头与可加总计', () => {
    const m = buildPivotMatrix(
      raw({
        rowFields: ['region'],
        columnFields: ['year'],
        rows: [
          ['华东', 2024, 50],
          ['华北', 2024, 10],
          ['华北', 2025, 20],
          ['华南', 2024, 30],
        ],
        totalRows: 4,
      }),
    );

    expect(m.rowLabels).toEqual([['华东'], ['华北'], ['华南']]);
    expect(m.columnHeaders.map((h) => h.labels)).toEqual([
      ['2024', 'sum(amount)'],
      ['2025', 'sum(amount)'],
    ]);
    expect(m.cells).toEqual([
      [50, null],
      [10, 20],
      [30, null],
    ]);
    // 行总计：华东 50、华北 30、华南 30；列总计：2024 = 90、2025 = 20
    expect(m.rowTotals).toEqual([50, 30, 30]);
    expect(m.colTotals).toEqual([90, 20]);
    expect(m.grandTotal).toBe(110);
    expect(m.columnDepth).toBe(2);
    expect(m.rowDepth).toBe(1);
    expect(m.rowsTruncated).toBe(false);
    expect(m.colsTruncated).toBe(false);
  });

  it('多度量：列数 = 列组合 × 度量数，列头末层为度量名，不提供总计', () => {
    const m = buildPivotMatrix(
      raw({
        rowFields: ['region'],
        columnFields: ['year'],
        values: [
          { field: 'amount', agg: 'sum', label: 'sum(amount)' },
          { field: 'amount', agg: 'count', label: 'count(amount)' },
        ],
        rows: [
          ['华南', 2024, 70, 2],
          ['华北', 2024, 10, 1],
        ],
      }),
    );

    expect(m.columnHeaders.map((h) => h.labels)).toEqual([
      ['2024', 'sum(amount)'],
      ['2024', 'count(amount)'],
    ]);
    expect(m.cells).toEqual([
      [70, 2],
      [10, 1],
    ]);
    expect(m.rowTotals).toBeNull();
    expect(m.colTotals).toBeNull();
    expect(m.grandTotal).toBeNull();
  });

  it('avg 度量不提供总计（不可加）', () => {
    const m = buildPivotMatrix(
      raw({
        rowFields: ['region'],
        values: [{ field: 'amount', agg: 'avg', label: 'avg(amount)' }],
        rows: [['华北', 10], ['华南', 35]],
      }),
    );
    expect(m.cells).toEqual([[10], [35]]);
    expect(m.rowTotals).toBeNull();
    expect(m.grandTotal).toBeNull();
  });

  it('多级行：行标签逐层展开，行数按组合去重', () => {
    const m = buildPivotMatrix(
      raw({
        rowFields: ['region', 'year'],
        values: [{ field: 'amount', agg: 'sum', label: 'sum(amount)' }],
        rows: [
          ['华北', 2024, 10],
          ['华北', 2025, 20],
          ['华南', 2024, 30],
        ],
      }),
    );
    expect(m.rowDepth).toBe(2);
    expect(m.rowLabels).toEqual([['华北', '2024'], ['华北', '2025'], ['华南', '2024']]);
    expect(m.cells).toEqual([[10], [20], [30]]);
  });

  it('无行无列维度：只有一行一列的总计', () => {
    const m = buildPivotMatrix(
      raw({
        rows: [[150]],
        totalRows: 5,
      }),
    );
    expect(m.rowLabels).toEqual([[]]);
    expect(m.columnHeaders.map((h) => h.labels)).toEqual([['sum(amount)']]);
    expect(m.cells).toEqual([[150]]);
    expect(m.rowDepth).toBe(1);
    expect(m.grandTotal).toBe(150);
  });

  it('空值分组显示为 (空)，缺失组合为 null（不计入合计）', () => {
    const m = buildPivotMatrix(
      raw({
        rowFields: ['region'],
        columnFields: ['year'],
        rows: [
          [null, 2024, 10],
          ['华北', 2024, 5],
          ['华北', 2025, 7],
        ],
      }),
    );
    expect(m.rowLabels).toEqual([['(空)'], ['华北']]);
    // (空) 组没有 2025 的数据 → 该单元格为 null，不计入合计
    expect(m.cells).toEqual([[10, null], [5, 7]]);
    expect(m.rowTotals).toEqual([10, 12]);
    expect(m.colTotals).toEqual([15, 7]);
    expect(m.grandTotal).toBe(22);
  });

  it('超过渲染上限时截断并给出标记', () => {
    const rows = Array.from({ length: 4 }, (_, i) => [`R${i}`, `C${i}`, i + 1]);
    const m = buildPivotMatrix(raw({ rowFields: ['r'], columnFields: ['c'], rows }), {
      maxRows: 2,
      maxCols: 1,
    });
    expect(m.rowsTruncated).toBe(true);
    expect(m.colsTruncated).toBe(true);
    expect(m.rowLabels).toHaveLength(2);
    expect(m.columnHeaders).toHaveLength(1);
    expect(m.cells).toHaveLength(2);
    expect(m.cells[0]).toHaveLength(1);
    // 总计基于显示出来的单元格，表内自洽
    expect(m.grandTotal).toBe(1);
  });

  it('空结果集：无行数列数', () => {
    const m = buildPivotMatrix(raw({ rowFields: ['region'], rows: [] }));
    expect(m.rowLabels).toEqual([]);
    expect(m.columnHeaders).toEqual([]);
    expect(m.cells).toEqual([]);
  });
});
