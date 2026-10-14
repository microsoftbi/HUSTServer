import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkflowStore } from '../src/store/workflowStore';

beforeEach(() => {
  useWorkflowStore.setState({
    workflowId: '', workflowName: '未命名工作流', workflowCreatedAt: 0,
    nodes: [], edges: [], selectedNodeId: null, dirty: false,
    inputSchemas: {}, nodeColumns: {},
  });
});

describe('workflowStore 画布操作（裁剪版）', () => {
  it('addNode 自增 id、写默认配置并选中', () => {
    useWorkflowStore.getState().addNode('inputCsv', { x: 0, y: 0 });
    const { nodes, selectedNodeId, dirty } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('n1');
    expect(nodes[0].name.length).toBeGreaterThan(0); // 取自 getNodeMeta(kind).label
    expect(selectedNodeId).toBe('n1');
    expect(dirty).toBe(true);
  });

  it('addEdge 阻止自环、未知端口与成环', () => {
    const s = useWorkflowStore.getState();
    s.addNode('inputCsv', { x: 0, y: 0 });
    s.addNode('outputCsv', { x: 200, y: 0 });
    s.addEdge({ source: 'n1', target: 'n2' });
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
    s.addEdge({ source: 'n1', target: 'n1' }); // 自环
    s.addEdge({ source: 'n2', target: 'n1' }); // 成环
    s.addEdge({ source: 'n9', target: 'n2' }); // 未知源
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });

  it('addEdge 用 reachable 守卫拒绝 a→b→a 成环，非法 sourceHandle 被拒', () => {
    const s = useWorkflowStore.getState();
    // select / sort 均有输入口 in 与输出口 out，可构成真正的 a→b→a 环
    s.addNode('select', { x: 0, y: 0 });
    s.addNode('sort', { x: 200, y: 0 });
    s.addNode('browser', { x: 400, y: 0 });
    s.addEdge({ source: 'n1', target: 'n2' }); // a→b 成功
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
    s.addEdge({ source: 'n2', target: 'n1' }); // b→a：端口合法、端口空闲，仅 reachable 守卫拦截
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
    s.addEdge({ source: 'n1', target: 'n3', sourceHandle: 'bad' }); // 非法 sourceHandle（n3 端口空闲，排除占用干扰）
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });

  it('loadWorkflow 归一化 handle、清 dirty 与 schemas', () => {
    useWorkflowStore.getState().loadWorkflow({
      id: 'w1', name: '示例', createdAt: 0, updatedAt: 0,
      nodes: [{ id: 'n1', kind: 'inputCsv', name: '读', position: { x: 0, y: 0 }, config: { path: '/a.csv' } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });
    const s = useWorkflowStore.getState();
    expect(s.workflowId).toBe('w1');
    expect(s.workflowName).toBe('示例');
    expect(s.dirty).toBe(false);
    expect(s.inputSchemas).toEqual({});
    // edges 引用了不存在的 n2：loadWorkflow 不做图校验（与上游行为一致），仅归一化 handle
    expect(s.edges[0].sourceHandle).toBe('out');
    expect(s.edges[0].targetHandle).toBe('in');
  });

  it('snapshot 返回当前图，markSaved 清 dirty', () => {
    const s = useWorkflowStore.getState();
    s.addNode('inputCsv', { x: 0, y: 0 });
    const snap = useWorkflowStore.getState().snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.id).toBe('');
    expect(useWorkflowStore.getState().dirty).toBe(true);
    useWorkflowStore.getState().markSaved();
    expect(useWorkflowStore.getState().dirty).toBe(false);
  });
});
