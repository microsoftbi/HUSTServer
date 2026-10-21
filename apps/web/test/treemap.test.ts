import { describe, expect, it } from 'vitest';
import {
  MAX_TILES,
  buildTreemapGroups,
  capLeaves,
  categoryColor,
  defaultTreemap,
  fitFontSize,
  fitLabel,
  mixHex,
  squarify,
  textWidth,
  treemapOf,
  valueColor,
} from '../src/features/dashboard/lib/treemap.js';
import type { ChartWidget, Dataset } from '../src/features/dashboard/types.js';

const dataset: Dataset = {
  id: 'ds1',
  name: '销售',
  source: 'sql',
  columns: [
    { name: 'region', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'amount', type: 'number' },
  ],
  rows: [
    ['华东', '上海', 50],
    ['华东', '杭州', 30],
    ['华北', '北京', 40],
    ['华南', '广州', 20],
    ['华南', '深圳', 0],
    ['华南', '广州', 10],
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  def: { kind: 'model', modelName: 'sales' },
};

describe('buildTreemapGroups', () => {
  it('无详细级别时按类别聚合，并按值降序排列', () => {
    const groups = buildTreemapGroups(dataset, {
      dimension: 'region',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(groups.map((g) => g.name)).toEqual(['华东', '华北', '华南']);
    expect(groups.map((g) => g.value)).toEqual([80, 40, 30]);
    expect(groups[0].leaves).toEqual([
      { name: '华东', category: '华东', value: 80 },
    ]);
  });

  it('有详细级别时按「类别 → 明细」两层聚合，同名明细合并', () => {
    const groups = buildTreemapGroups(dataset, {
      dimension: 'region',
      series: 'city',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(groups[0]).toEqual({
      name: '华东',
      value: 80,
      leaves: [
        { name: '上海', category: '华东', value: 50 },
        { name: '杭州', category: '华东', value: 30 },
      ],
    });
    // 广州两行合并为 30，深圳为 0 被丢弃
    expect(groups[2].leaves).toEqual([
      { name: '广州', category: '华南', value: 30 },
    ]);
  });

  it('非正值不参与布局（与 Power BI 一致）', () => {
    const groups = buildTreemapGroups(dataset, {
      dimension: 'city',
      series: 'region',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(groups.map((g) => g.name)).toEqual(['上海', '北京', '杭州', '广州']);
    expect(groups.some((g) => g.name === '深圳')).toBe(false);
  });

  it('没有类别字段时整体作为单个分组', () => {
    const groups = buildTreemapGroups(dataset, {
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(groups).toEqual([
      {
        name: 'sum(amount)',
        value: 150,
        leaves: [{ name: 'sum(amount)', category: 'sum(amount)', value: 150 }],
      },
    ]);
  });

  it('计数度量按行数聚合', () => {
    const groups = buildTreemapGroups(dataset, {
      dimension: 'region',
      measures: [{ field: 'city', agg: 'count' }],
    });
    expect(groups.map((g) => [g.name, g.value])).toEqual([
      ['华南', 3],
      ['华东', 2],
      ['华北', 1],
    ]);
  });

  it('字段缺失或没有度量时返回空数组', () => {
    expect(
      buildTreemapGroups(dataset, {
        dimension: 'region',
        measures: [{ field: 'missing', agg: 'sum' }],
      }),
    ).toEqual([]);
    expect(
      buildTreemapGroups(dataset, { dimension: 'region', measures: [] }),
    ).toEqual([]);
  });

  it('图块数超过上限时只保留值最大的叶子', () => {
    const big: Dataset = {
      ...dataset,
      rows: Array.from({ length: MAX_TILES + 10 }, (_, i) => [
        '华东',
        `城市${i}`,
        i + 1,
      ]),
    };
    const groups = buildTreemapGroups(big, {
      dimension: 'region',
      series: 'city',
      measures: [{ field: 'amount', agg: 'sum' }],
    });
    expect(groups[0].leaves).toHaveLength(MAX_TILES);
    expect(groups[0].leaves[0].name).toBe(`城市${MAX_TILES + 9}`);
    expect(
      groups[0].leaves.reduce((sum, leaf) => sum + leaf.value, 0),
    ).toBe(groups[0].value);
  });

  it('capLeaves 对多分组按全局值裁剪并重算分组总值', () => {
    const groups = [
      {
        name: 'A',
        value: 30,
        leaves: [
          { name: 'a1', category: 'A', value: 20 },
          { name: 'a2', category: 'A', value: 10 },
        ],
      },
      {
        name: 'B',
        value: 40,
        leaves: [{ name: 'b1', category: 'B', value: 40 }],
      },
    ];
    const capped = capLeaves(groups, 2);
    expect(capped.map((g) => g.name)).toEqual(['B', 'A']);
    expect(capped[1]).toEqual({
      name: 'A',
      value: 20,
      leaves: [{ name: 'a1', category: 'A', value: 20 }],
    });
  });
});

describe('squarify', () => {
  const items = [
    { name: 'a', value: 6 },
    { name: 'b', value: 6 },
    { name: 'c', value: 4 },
    { name: 'd', value: 3 },
    { name: 'e', value: 2 },
    { name: 'f', value: 2 },
    { name: 'g', value: 1 },
  ];

  it('图块面积与值成正比且铺满整个区域', () => {
    const box = { x: 0, y: 0, w: 600, h: 400 };
    const tiles = squarify(items, box);
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const area = box.w * box.h;

    expect(tiles).toHaveLength(items.length);
    for (const tile of tiles) {
      expect(tile.rect.x).toBeGreaterThanOrEqual(0);
      expect(tile.rect.y).toBeGreaterThanOrEqual(0);
      expect(tile.rect.x + tile.rect.w).toBeLessThanOrEqual(box.w + 1e-6);
      expect(tile.rect.y + tile.rect.h).toBeLessThanOrEqual(box.h + 1e-6);
      expect((tile.rect.w * tile.rect.h) / tile.item.value).toBeCloseTo(
        area / total,
        2,
      );
    }
    const covered = tiles.reduce(
      (sum, tile) => sum + tile.rect.w * tile.rect.h,
      0,
    );
    expect(covered).toBeCloseTo(area, 2);
  });

  it('图块互不重叠且保持降序（最大者位于左上）', () => {
    const tiles = squarify(items, { x: 0, y: 0, w: 600, h: 400 });
    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        const a = tiles[i].rect;
        const b = tiles[j].rect;
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(Math.max(0, overlapW) * Math.max(0, overlapH)).toBeLessThan(1e-6);
      }
    }
    expect(tiles[0].item.value).toBe(6);
    expect(tiles[0].rect.x).toBeLessThanOrEqual(1e-6);
    expect(tiles[0].rect.y).toBeLessThanOrEqual(1e-6);
  });

  it('矩形尽量接近正方形（最大宽高比受控）', () => {
    const tiles = squarify(items, { x: 0, y: 0, w: 600, h: 400 });
    const worst = Math.max(
      ...tiles.map((tile) => {
        const { w, h } = tile.rect;
        return Math.max(w / h, h / w);
      }),
    );
    expect(worst).toBeLessThan(4);
  });

  it('忽略非正值；空区域返回空数组', () => {
    const tiles = squarify(
      [
        { name: 'a', value: 10 },
        { name: 'b', value: 0 },
        { name: 'c', value: -5 },
      ],
      { x: 0, y: 0, w: 100, h: 100 },
    );
    expect(tiles.map((t) => t.item.name)).toEqual(['a']);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
    expect(squarify([], { x: 0, y: 0, w: 100, h: 100 })).toEqual([]);
  });

  it('支持偏移区域（嵌套布局）', () => {
    const tiles = squarify(items, { x: 20, y: 30, w: 200, h: 100 });
    for (const tile of tiles) {
      expect(tile.rect.x).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(tile.rect.y).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(tile.rect.x + tile.rect.w).toBeLessThanOrEqual(220 + 1e-6);
      expect(tile.rect.y + tile.rect.h).toBeLessThanOrEqual(130 + 1e-6);
    }
  });
});

describe('配色与标签', () => {
  it('按类别取主题色并循环使用', () => {
    expect(categoryColor(0)).toBe(categoryColor(8));
    expect(categoryColor(0)).not.toBe(categoryColor(1));
  });

  it('按值渐变：最大值使用基础色，较小值更浅', () => {
    expect(valueColor(100, 100, '#2563eb')).toBe('#2563eb');
    expect(valueColor(50, 100, '#2563eb')).not.toBe('#2563eb');
    expect(valueColor(10, 100, '#2563eb')).not.toBe(valueColor(50, 100, '#2563eb'));
  });

  it('单色模式始终返回基础色', () => {
    expect(valueColor(1, 100, '#123456', 'single')).toBe('#123456');
  });

  it('mixHex 按比例混合颜色', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#2563eb', '#ffffff', 0)).toBe('#2563eb');
    expect(mixHex('#2563eb', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#2563eb', '#ffffff', 0.5)).toBe(mixHex('#ffffff', '#2563eb', 0.5));
  });

  it('文本宽度按中英文分别估算', () => {
    expect(textWidth('中文', 10)).toBe(20);
    expect(textWidth('ab', 10)).toBeCloseTo(11, 5);
  });

  it('超宽标签截断并追加省略号，且不超过可用宽度', () => {
    const label = fitLabel('这是一个很长很长的分类名称', 40, 10);
    expect(label.endsWith('…')).toBe(true);
    expect(textWidth(label, 10)).toBeLessThanOrEqual(40);
    expect(fitLabel('短', 40, 10)).toBe('短');
  });

  it('字号在空间不足时收缩，但有下限', () => {
    expect(fitFontSize('ABCD', 40, 14)).toBe(14);
    expect(fitFontSize('ABCDEFGHIJKLMNOP', 40, 14)).toBe(8);
    expect(fitFontSize('任意文本', 0, 14)).toBe(8);
  });
});

describe('treemapOf', () => {
  it('缺少配置时补全默认值，存在配置时保留用户覆盖', () => {
    const base: ChartWidget = {
      id: 'w1',
      type: 'treemap',
      title: '',
      datasetId: 'ds1',
      encoding: { measures: [] },
      layout: { x: 0, y: 0, w: 400, h: 300 },
    };
    expect(treemapOf(base)).toEqual(defaultTreemap());
    expect(
      treemapOf({
        ...base,
        treemap: { ...defaultTreemap(), colorMode: 'single', groupPadding: 4 },
      }),
    ).toMatchObject({ colorMode: 'single', groupPadding: 4 });
  });
});
