import { describe, expect, it } from 'vitest';
import { buildMappingInputs } from '../src/workflowMappings.js';
import type { InputRef, OutputRef } from '../src/types.js';

const inputs: InputRef[] = [
  { nodeId: 'n1', name: '读取订单', kind: 'inputCsv', originalRef: '/Users/me/a.csv', binding: 'file' },
  { nodeId: 'n2', name: '读库', kind: 'inputSqlServer', originalRef: 'db:1433/d', binding: 'connection' },
];
const outputs: OutputRef[] = [
  { nodeId: 'n3', name: '导出', kind: 'outputCsv', originalRef: '/Users/me/out.csv' },
];

describe('buildMappingInputs', () => {
  it('上传文件与连接分别生成正确 target，输出固定为 output_dir', () => {
    const drafts = buildMappingInputs(inputs, outputs, {
      n1: { targetType: 'uploaded_file', targetRef: '171_a.csv' },
      n2: { targetType: 'connection', targetRef: 'conn1' },
    });
    expect(drafts).toEqual([
      { node_id: 'n1', direction: 'input', original_ref: '/Users/me/a.csv', target_type: 'uploaded_file', target_ref: '171_a.csv' },
      { node_id: 'n2', direction: 'input', original_ref: 'db:1433/d', target_type: 'connection', target_ref: 'conn1' },
      { node_id: 'n3', direction: 'output', original_ref: '/Users/me/out.csv', target_type: 'output_dir', target_ref: null },
    ]);
  });

  it('server_path 绑定使用服务端绝对路径', () => {
    const drafts = buildMappingInputs(inputs, [], {
      n1: { targetType: 'server_path', targetRef: '/srv/data/a.csv' },
    });
    expect(drafts[0]).toMatchObject({ target_type: 'server_path', target_ref: '/srv/data/a.csv' });
  });

  it('未绑定或绑定为空的输入被跳过，不产生不完整映射', () => {
    const drafts = buildMappingInputs(inputs, [], {
      n1: { targetType: 'uploaded_file', targetRef: '   ' },
    });
    expect(drafts).toHaveLength(0);
  });
});
