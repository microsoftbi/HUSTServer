import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorkflowPayload, WorkflowParseError } from '../src/modules/workflows/parse.js';

const sample = readFileSync(fileURLToPath(new URL('./fixtures/sample-workflow.json', import.meta.url)), 'utf8');

describe('parseWorkflowPayload', () => {
  it('解析合法工作流并抽取输入/输出引用', () => {
    const { workflow, inputs, outputs } = parseWorkflowPayload(sample);
    expect(workflow.nodes).toHaveLength(3);
    expect(inputs).toEqual([
      { nodeId: 'n1', name: '读取订单', kind: 'inputCsv', originalRef: '/Users/me/data/orders.csv', binding: 'file' },
    ]);
    expect(outputs).toEqual([
      { nodeId: 'n3', name: '导出结果', kind: 'outputCsv', originalRef: '/Users/me/data/out.csv' },
    ]);
  });

  it('SQL Server 输入被识别为连接绑定且不泄露明文', () => {
    const text = JSON.stringify({
      id: 'wf', name: 'sql', createdAt: 0, updatedAt: 0,
      nodes: [{ id: 's1', kind: 'inputSqlServer', name: '读库', position: { x: 0, y: 0 },
        config: { connection: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' }, query: 'select 1' } }],
      edges: [],
    });
    const { inputs } = parseWorkflowPayload(text);
    expect(inputs[0]).toMatchObject({ nodeId: 's1', kind: 'inputSqlServer', binding: 'connection' });
    expect(JSON.stringify(inputs[0])).not.toContain('secret');
  });

  it('非对象/缺字段/未知 kind/悬空连线/重复 id 均抛 WorkflowParseError', () => {
    expect(() => parseWorkflowPayload('not json')).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload('{"nodes":[]}')).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload(JSON.stringify({ id: 'w', name: 'w', nodes: [{ id: 'a', kind: 'bogus', name: 'x', position: { x: 0, y: 0 }, config: {} }], edges: [] }))).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload(JSON.stringify({ id: 'w', name: 'w', nodes: [{ id: 'a', kind: 'filter', name: 'x', position: { x: 0, y: 0 }, config: {} }], edges: [{ id: 'e', source: 'a', target: 'missing' }] }))).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload(JSON.stringify({ id: 'w', name: 'w', nodes: [{ id: 'a', kind: 'filter', name: 'x', position: { x: 0, y: 0 }, config: {} }, { id: 'a', kind: 'filter', name: 'y', position: { x: 0, y: 0 }, config: {} }], edges: [] }))).toThrow(WorkflowParseError);
  });
});
