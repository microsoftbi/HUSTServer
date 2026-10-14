import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { MousePointerClick } from 'lucide-react';
import { nodeTypes, type HusterNodeData } from '@/components/canvas/NodeCard';
import { getNodeMeta, type NodeCategory } from '@/lib/nodeMeta';
import { useWorkflowStore } from '@/store/workflowStore';
import type { NodeKind } from '@/types';

const MINIMAP_COLOR: Record<NodeCategory, string> = {
  input: '#0ea5e9',
  transform: '#8b5cf6',
  output: '#10b981',
};

export function FlowCanvas() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const addNode = useWorkflowStore((s) => s.addNode);
  const addEdge = useWorkflowStore((s) => s.addEdge);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const removeEdge = useWorkflowStore((s) => s.removeEdge);
  const setNodePosition = useWorkflowStore((s) => s.setNodePosition);
  const selectNode = useWorkflowStore((s) => s.selectNode);

  const { screenToFlowPosition } = useReactFlow();

  /**
   * React Flow 测量得到的节点尺寸。
   * 受控模式下 React Flow 不会把 `measured` 写回我们传入的节点对象，
   * 而右下角 MiniMap 只会渲染带尺寸的节点，因此这里自行保存并回填，
   * 否则鹰眼视图会看不到任何节点。
   */
  const [nodeDimensions, setNodeDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});

  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => {
        const measured = nodeDimensions[node.id];
        return {
          id: node.id,
          type: 'huster',
          position: node.position,
          selected: node.id === selectedNodeId,
          ...(measured ? { measured } : {}),
          data: {
            node,
            status: 'pending',
            rowCount: 0,
            durationMs: 0,
            runActive: false,
            inScope: true,
            frozen: false,
          } satisfies HusterNodeData,
        };
      }),
    [nodes, selectedNodeId, nodeDimensions],
  );

  const rfEdges = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? 'out',
        targetHandle: edge.targetHandle ?? 'in',
      })),
    [edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const measuredUpdates: Record<string, { width: number; height: number }> = {};
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          setNodePosition(change.id, change.position);
        } else if (change.type === 'remove') {
          removeNode(change.id);
        } else if (change.type === 'select' && change.selected) {
          selectNode(change.id);
        } else if (change.type === 'dimensions' && change.dimensions) {
          measuredUpdates[change.id] = change.dimensions;
        }
      }
      if (Object.keys(measuredUpdates).length > 0) {
        setNodeDimensions((prev) => {
          let changed = false;
          for (const [id, dim] of Object.entries(measuredUpdates)) {
            const current = prev[id];
            if (!current || current.width !== dim.width || current.height !== dim.height) {
              changed = true;
              break;
            }
          }
          return changed ? { ...prev, ...measuredUpdates } : prev;
        });
      }
    },
    [removeNode, selectNode, setNodePosition],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type !== 'remove') continue;
        removeEdge(change.id);
      }
    },
    [removeEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      addEdge({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      });
    },
    [addEdge],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData('application/husteryx-node') as NodeKind;
      if (!kind || !getNodeMeta(kind)) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(kind, position);
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onPaneClick={() => selectNode(null)}
      nodeTypes={nodeTypes}
      colorMode="dark"
      deleteKeyCode={['Backspace', 'Delete']}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      <Controls className="!rounded-md !border !border-border !bg-card !shadow-md" />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => {
          const data = node.data as HusterNodeData | undefined;
          if (!data?.node) return '#64748b';
          return MINIMAP_COLOR[getNodeMeta(data.node.kind).category];
        }}
        maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
        className="!bg-card"
      />
      {nodes.length === 0 && (
        <Panel position="top-center" className="pointer-events-none mt-24">
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card/70 px-6 py-5 text-center">
            <MousePointerClick className="size-6 text-muted-foreground" />
            <div className="text-sm font-medium">从左侧节点库拖拽节点到画布</div>
            <div className="text-xs text-muted-foreground">
              依次连接「输入 → 转换 → 输出」，即可构建 ETL 工作流
            </div>
          </div>
        </Panel>
      )}
    </ReactFlow>
  );
}
