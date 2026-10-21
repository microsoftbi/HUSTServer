import { describe, expect, it } from 'vitest';
import {
  AI_HIGH,
  AI_LOW,
  ROOT_KEY,
  aiSplitField,
  buildDecomposition,
  collectColumns,
  decompositionOf,
  defaultDecomposition,
  layoutDecomposition,
  nodeKey,
  valueRatio,
} from '../src/features/dashboard/lib/decomposition.js';
import type { ChartWidget, Dataset } from '../src/features/dashboard/types.js';

const dataset: Dataset = {
  id: 'ds1',
  name: '销售',
  source: 'sql',
  columns: [
    { name: 'region', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'amount', type: 'number' },
  ],
  rows: [
    ['华东', '上海', '线上', 50],
    ['华东', '杭州', '线上', 30],
    ['华北', '北京', '线下', 40],
    ['华南', '广州', '线下', 20],
    ['华南', '深圳', '线上', 10],
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  def: { kind: 'model', modelName: 'sales' },
};

const measure = { field: 'amount', agg: 'sum' as const };

describe('nodeKey', () => {
  it('根节点使用固定 key，子节点按条件编码并转义特殊字符', () => {
    expect(nodeKey([])).toBe(ROOT_KEY);
    const key = nodeKey([
      { field: 'region', value: '华东' },
      { field: 'city', value: 'a=b|c' },
    ]);
    expect(key).not.toContain('|a=b');
    expect(nodeKey([{ field: 'region', value: '华东' }])).not.toBe(
      nodeKey([{ field: 'region', value: '华北' }]),
    );
  });
});

describe('buildDecomposition', () => {
  it('根节点为度量合计，未展开时没有子节点', () => {
    const root = buildDecomposition(dataset, measure, ['region'], {});
    expect(root).toMatchObject({ key: ROOT_KEY, name: 'amount', value: 150, depth: 0 });
    expect(root?.children).toEqual([]);
  });

  it('按说明依据逐层拆分，节点按值降序且保留层级字段', () => {
    const regionKey = nodeKey([{ field: 'region', value: '华东' }]);
    const root = buildDecomposition(dataset, measure, ['region', 'city'], {
      [ROOT_KEY]: 'region',
      [regionKey]: 'city',
    });
    expect(root?.children.map((c) => [c.name, c.value, c.field])).toEqual([
      ['华东', 80, 'region'],
      ['华北', 40, 'region'],
      ['华南', 30, 'region'],
    ]);
    expect(root?.children[0].children.map((c) => [c.name, c.value, c.field])).toEqual([
      ['上海', 50, 'city'],
      ['杭州', 30, 'city'],
    ]);
    expect(root?.children[0].children[0].depth).toBe(2);
  });

  it('每级只保留前 maxBars 个节点', () => {
    const root = buildDecomposition(dataset, measure, ['region'], {
      [ROOT_KEY]: 'region',
    }, { maxBars: 2 });
    expect(root?.children.map((c) => c.name)).toEqual(['华东', '华北']);
  });

  it('忽略不存在的字段与无效展开，不会抛错', () => {
    const root = buildDecomposition(dataset, measure, ['region'], {
      [ROOT_KEY]: 'missing',
    });
    expect(root?.children).toEqual([]);

    const stale = buildDecomposition(dataset, measure, [], {
      [ROOT_KEY]: 'region',
    });
    expect(stale?.children).toEqual([]);

    expect(
      buildDecomposition(dataset, { field: 'missing', agg: 'sum' }, ['region'], {}),
    ).toBeNull();
  });

  it('没有展开配置时保留根节点，用于显示合计', () => {
    const root = buildDecomposition(dataset, measure, ['region'], {});
    expect(root).not.toBeNull();
    expect(collectColumns(root!)).toHaveLength(1);
  });

  it('计数度量使用行数', () => {
    const root = buildDecomposition(dataset, { field: 'city', agg: 'count' }, ['region'], {
      [ROOT_KEY]: 'region',
    });
    expect(root?.value).toBe(5);
    expect(root?.children.map((c) => [c.name, c.value])).toEqual([
      ['华东', 2],
      ['华南', 2],
      ['华北', 1],
    ]);
  });
});

describe('aiSplitField', () => {
  it('高值选择头部类别占比最高的字段', () => {
    expect(aiSplitField(dataset, dataset.rows, measure, ['region', 'city', 'channel'], AI_HIGH)).toBe(
      'channel',
    );
  });

  it('低值选择最低类别偏离均值最大的字段', () => {
    expect(aiSplitField(dataset, dataset.rows, measure, ['region', 'city', 'channel'], AI_LOW)).toBe(
      'city',
    );
  });

  it('跳过已用于祖先节点的字段，回退后仍能选出字段', () => {
    expect(
      aiSplitField(
        dataset,
        dataset.rows,
        measure,
        ['channel', 'region'],
        AI_HIGH,
        ['channel'],
      ),
    ).toBe('region');
  });

  it('无可用字段或分组不足两项时返回 null', () => {
    expect(aiSplitField(dataset, dataset.rows, measure, [], AI_HIGH)).toBeNull();
    expect(aiSplitField(dataset, dataset.rows, measure, ['amount'], AI_HIGH)).toBeNull();
  });

  it('展开配置为 AI 拆分时动态选择字段', () => {
    const root = buildDecomposition(dataset, measure, ['region', 'city', 'channel'], {
      [ROOT_KEY]: AI_HIGH,
    });
    expect(root?.children.map((c) => c.name)).toEqual(['线上', '线下']);
    expect(root?.children[0].field).toBe('channel');

    const low = buildDecomposition(dataset, measure, ['region', 'city', 'channel'], {
      [ROOT_KEY]: AI_LOW,
    });
    expect(low?.children[0].field).toBe('city');
    expect(low?.children[0].name).toBe('上海');
  });

  it('关闭 AI 拆分时不执行', () => {
    const root = buildDecomposition(
      dataset,
      measure,
      ['region'],
      { [ROOT_KEY]: AI_HIGH },
      { aiSplits: false },
    );
    expect(root?.children).toEqual([]);
  });
});

describe('layoutDecomposition', () => {
  const regionKey = nodeKey([{ field: 'region', value: '华东' }]);
  const root = buildDecomposition(dataset, measure, ['region', 'city'], {
    [ROOT_KEY]: 'region',
    [regionKey]: 'city',
  })!;

  const options = {
    columnWidth: 100,
    columnGap: 20,
    nodeHeight: 24,
    rowGap: 8,
    headerHeight: 20,
    rootHeader: 'amount',
  };

  it('按层级生成列、标题与整体尺寸', () => {
    const layout = layoutDecomposition(root, options);
    expect(layout.columns).toBe(3);
    expect(layout.headers).toEqual(['amount', 'region', 'city']);
    expect(layout.width).toBe(3 * 100 + 2 * 20);
    expect(layout.height).toBeGreaterThan(20);
    expect(layout.boxes).toHaveLength(6);
    expect(layout.boxes.filter((b) => b.column === 0)).toHaveLength(1);
    expect(layout.boxes.filter((b) => b.column === 1)).toHaveLength(3);
    expect(layout.boxes.filter((b) => b.column === 2)).toHaveLength(2);
  });

  it('父节点垂直居中于子节点区域，且同列节点不重叠', () => {
    const layout = layoutDecomposition(root, options);
    const byKey = new Map(layout.boxes.map((b) => [b.node.key, b]));

    for (const box of layout.boxes) {
      if (!box.parentKey) continue;
      const siblings = layout.boxes.filter((b) => b.parentKey === box.parentKey);
      const parent = byKey.get(box.parentKey)!;
      const first = siblings[0];
      const last = siblings[siblings.length - 1];
      const childrenCenter = (first.y + (last.y + last.h)) / 2;
      expect(parent.y + parent.h / 2).toBeCloseTo(childrenCenter, 6);
    }

    for (let column = 0; column < layout.columns; column += 1) {
      const boxes = layout.boxes
        .filter((b) => b.column === column)
        .sort((a, b) => a.y - b.y);
      for (let i = 1; i < boxes.length; i += 1) {
        expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h);
      }
    }
  });

  it('所有节点位于列宽范围内，并按列等距排列', () => {
    const layout = layoutDecomposition(root, options);
    for (const box of layout.boxes) {
      expect(box.w).toBe(100);
      expect(box.h).toBe(24);
      expect(box.x).toBe(box.column * 120);
      expect(box.y).toBeGreaterThanOrEqual(20);
    }
  });

  it('只有根节点时也能得到单列布局', () => {
    const layout = layoutDecomposition(root, {
      ...options,
      rootHeader: 'amount',
    });
    const single = layoutDecomposition(
      { ...root, children: [] },
      { ...options, rootHeader: 'amount' },
    );
    expect(single.columns).toBe(1);
    expect(single.headers).toEqual(['amount']);
    expect(single.boxes).toHaveLength(1);
    expect(layout.boxes.length).toBeGreaterThan(1);
  });
});

describe('配置与比例', () => {
  it('默认配置与部分覆盖合并', () => {
    const widget: ChartWidget = {
      id: 'w1',
      type: 'decomposition',
      title: '',
      datasetId: 'ds1',
      encoding: { measures: [] },
      layout: { x: 0, y: 0, w: 400, h: 300 },
    };
    expect(decompositionOf(widget)).toEqual(defaultDecomposition());
    expect(
      decompositionOf({
        ...widget,
        decomposition: { ...defaultDecomposition(), maxBars: 3, aiSplits: false },
      }),
    ).toMatchObject({ maxBars: 3, aiSplits: false });
  });

  it('数据条比例按根节点归一化并限制在 0~1', () => {
    expect(valueRatio(75, 150)).toBe(0.5);
    expect(valueRatio(200, 150)).toBe(1);
    expect(valueRatio(-10, 150)).toBe(0);
    expect(valueRatio(10, 0)).toBe(0);
  });
});
