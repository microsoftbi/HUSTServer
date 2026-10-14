import { describe, expect, it } from 'vitest';
import type { Workflow } from '@hustserver/engine';
import { buildRuntimeWorkflow } from '../src/modules/workflows/mapper.js';
import type { PathMappingRow } from '../src/modules/workflows/repo.js';

const workflow: Workflow = {
  id: 'wf1', name: 'demo', createdAt: 0, updatedAt: 0,
  nodes: [
    { id: 'in1', kind: 'inputCsv', name: 'A', position: { x: 0, y: 0 }, config: { path: '/Users/me/a.csv' } },
    { id: 'in2', kind: 'inputSqlServer', name: 'B', position: { x: 0, y: 0 }, config: { connection: { server: 'old', port: 1433, database: 'd', user: 'sa', password: 'plain' }, query: 'select 1' } },
    { id: 'out1', kind: 'outputCsv', name: 'C', position: { x: 0, y: 0 }, config: { path: '/Users/me/out.csv' } },
  ],
  edges: [],
};

const mappings: PathMappingRow[] = [
  { id: 'm1', workflow_id: 'wf1', node_id: 'in1', direction: 'input', original_ref: '/Users/me/a.csv', target_type: 'uploaded_file', target_ref: '171_ a.csv' },
  { id: 'm2', workflow_id: 'wf1', node_id: 'in2', direction: 'input', original_ref: 'old:1433/d', target_type: 'connection', target_ref: 'conn1' },
  { id: 'm3', workflow_id: 'wf1', node_id: 'out1', direction: 'output', original_ref: '/Users/me/out.csv', target_type: 'output_dir', target_ref: null },
];

describe('buildRuntimeWorkflow', () => {
  it('重写输入路径、替换连接、重定向输出，且不改原对象', () => {
    const runtime = buildRuntimeWorkflow({
      workflow, mappings, files: [], workflowId: 'wf1', runId: 'run9',
      deps: {
        uploadDir: '/data/uploads', outputDir: '/data/outputs',
        resolveServerPath: (rel) => `/srv/${rel}`,
        connections: new Map([['conn1', { id: 'conn1', config: { server: 'db.internal', port: 1433, database: 'prod', user: 'app', password: 'enc' } }]]),
      },
    });
    const byId = Object.fromEntries(runtime.nodes.map((n) => [n.id, n]));
    expect((byId.in1.config as { path: string }).path).toBe('/data/uploads/wf1/171_ a.csv');
    expect((byId.in2.config as { connection: { server: string } }).connection.server).toBe('db.internal');
    expect((byId.out1.config as { path: string }).path).toBe('/data/outputs/wf1/run9/out.csv');
    // 原工作流未受影响
    expect((workflow.nodes[0].config as { path: string }).path).toBe('/Users/me/a.csv');
  });

  it('未提供映射的节点保持原样', () => {
    const runtime = buildRuntimeWorkflow({
      workflow, mappings: [], files: [], workflowId: 'wf1', runId: 'run9',
      deps: { uploadDir: '/u', outputDir: '/o', resolveServerPath: (r) => r, connections: new Map() },
    });
    expect((runtime.nodes[0].config as { path: string }).path).toBe('/Users/me/a.csv');
  });

  it('工作流私有连接优先于全局连接映射', () => {
    const runtime = buildRuntimeWorkflow({
      workflow, mappings, files: [], workflowId: 'wf1', runId: 'run9',
      deps: {
        uploadDir: '/data/uploads', outputDir: '/data/outputs',
        resolveServerPath: (rel) => `/srv/${rel}`,
        connections: new Map([['conn1', { id: 'conn1', config: { server: 'db.internal', port: 1433, database: 'prod', user: 'app', password: 'enc' } }]]),
        workflowConnections: new Map([['in2', { server: 'private.host', port: 1433, database: 'pd', user: 'u', password: 'p' }]]),
      },
    });
    const in2 = runtime.nodes.find((n) => n.id === 'in2')!;
    expect((in2.config as { connection: { server: string } }).connection.server).toBe('private.host');
  });
});
