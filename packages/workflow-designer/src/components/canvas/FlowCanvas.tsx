import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { MousePointerClick, Play, Snowflake, Unlock, Copy, Power, PowerOff } from 'lucide-react';
import { nodeTypes, type HusterNodeData } from '@/components/canvas/NodeCard';
import { useDesignerHost } from '@/context';
import { formatInt } from '@/lib/format';
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
  const setNodePositions = useWorkflowStore((s) => s.setNodePositions);
  const selectNode = useWorkflowStore((s) => s.selectNode);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const copyNode = useWorkflowStore((s) => s.copyNode);
  const pasteNode = useWorkflowStore((s) => s.pasteNode);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);
  const toggleNodeDisabled = useWorkflowStore((s) => s.toggleNodeDisabled);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const nodeStatus = useWorkflowStore((s) => s.nodeStatus);
  const nodeResults = useWorkflowStore((s) => s.nodeResults);
  const runScope = useWorkflowStore((s) => s.runScope);
  const run = useWorkflowStore((s) => s.run);
  const cacheTo = useWorkflowStore((s) => s.cacheTo);
  const clearCache = useWorkflowStore((s) => s.clearCache);
  const cacheToken = useWorkflowStore((s) => s.cacheToken);
  const cachedNodeIds = useWorkflowStore((s) => s.cachedNodeIds);

  const { screenToFlowPosition } = useReactFlow();
  const { colorMode } = useDesignerHost();

  /**
   * React Flow 测量得到的节点尺寸。
   * 受控模式下 React Flow 不会把 `measured` 写回我们传入的节点对象，
   * 而右下角 MiniMap 只会渲染带尺寸的节点，因此这里自行保存并回填，
   * 否则鹰眼视图会看不到任何节点。
   */
  const [nodeDimensions, setNodeDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});

  /** 节点右键菜单（运行至此 / 缓存至此 / 取消缓存）；记录目标节点与屏幕坐标。 */
  const [menu, setMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);

  /** 是否正在运行（严格运行中：锁定编辑）。 */
  const running = runStatus === 'running';
  /** 是否处于一次运行的生命周期内（含成功/失败态，用于节点置灰）。 */
  const runActive = runStatus !== 'idle';
  /** 被「缓存至此」冻结（已缓存）的节点集合。 */
  const cachedSet = useMemo(() => new Set(cachedNodeIds), [cachedNodeIds]);

  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => {
        const measured = nodeDimensions[node.id];
        const frozen = cachedSet.has(node.id);
        return {
          id: node.id,
          type: 'huster',
          position: node.position,
          selected: node.id === selectedNodeId,
          draggable: !running && !frozen,
          ...(measured ? { measured } : {}),
          data: {
            node,
            status: nodeStatus[node.id] ?? 'pending',
            rowCount: nodeResults[node.id]?.rowCount ?? 0,
            durationMs: nodeResults[node.id]?.durationMs ?? 0,
            runActive,
            inScope: runScope.includes(node.id),
            frozen,
          } satisfies HusterNodeData,
        };
      }),
    [
      nodes,
      selectedNodeId,
      nodeDimensions,
      nodeStatus,
      nodeResults,
      runActive,
      runScope,
      running,
      cachedSet,
    ],
  );

  const nodeKindById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.kind])),
    [nodes],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const status = nodeStatus[edge.source];
        const result = nodeResults[edge.source];
        const sourceKind = nodeKindById.get(edge.source);
        // 多输出节点（如 Filter 的 T/F）各端口行数不一，连线标签无法准确表达，故隐藏。
        const multiOutput = sourceKind ? getNodeMeta(sourceKind).outputs.length > 1 : false;
        // 连线上流过的行数即起点节点的输出行数；起点执行成功后才标注。
        const rowLabel =
          !multiOutput && status === 'success' && result
            ? `${formatInt(result.rowCount)} 行`
            : null;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? 'out',
          targetHandle: edge.targetHandle ?? 'in',
          animated: status === 'running',
          ...(rowLabel
            ? {
                label: rowLabel,
                labelShowBg: true,
                labelBgPadding: [6, 2] as [number, number],
                labelBgBorderRadius: 4,
                labelBgStyle: { fill: 'var(--card)', stroke: 'var(--border)', strokeWidth: 1 },
                labelStyle: { fill: 'var(--foreground)', fontSize: 10, fontWeight: 600 },
              }
            : {}),
        };
      }),
    [edges, nodeStatus, nodeResults, nodeKindById],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const measuredUpdates: Record<string, { width: number; height: number }> = {};
      const positionUpdates: Record<string, { x: number; y: number }> = {};
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (running || cachedSet.has(change.id)) continue;
          positionUpdates[change.id] = change.position;
        } else if (change.type === 'remove') {
          if (running || cachedSet.has(change.id)) continue;
          removeNode(change.id);
        } else if (change.type === 'select' && change.selected) {
          selectNode(change.id);
        } else if (change.type === 'dimensions' && change.dimensions) {
          measuredUpdates[change.id] = change.dimensions;
        }
      }
      // 批量提交坐标：多选拖动时只记一步撤销。
      if (Object.keys(positionUpdates).length === 1) {
        const [id, position] = Object.entries(positionUpdates)[0];
        setNodePosition(id, position);
      } else if (Object.keys(positionUpdates).length > 1) {
        setNodePositions(positionUpdates);
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
    [removeNode, selectNode, setNodePosition, setNodePositions, running, cachedSet],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (running) return;
      for (const change of changes) {
        if (change.type !== 'remove') continue;
        // 冻结节点（含其连线）不可变更，避免破坏已缓存的上游链路。
        const edge = edges.find((item) => item.id === change.id);
        if (edge && (cachedSet.has(edge.source) || cachedSet.has(edge.target))) continue;
        removeEdge(change.id);
      }
    },
    [edges, removeEdge, running, cachedSet],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (running) return;
      // 冻结节点不可作为连线的任一端点。
      if (cachedSet.has(connection.source) || cachedSet.has(connection.target)) return;
      addEdge({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      });
    },
    [addEdge, running, cachedSet],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (running) return;
      const kind = event.dataTransfer.getData('application/husteryx-node') as NodeKind;
      if (!kind || !getNodeMeta(kind)) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(kind, position);
    },
    [addNode, screenToFlowPosition, running],
  );

  /** 节点右键：弹出菜单（运行中不弹）。 */
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      if (running) return;
      selectNode(node.id);
      setMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
    },
    [running, selectNode],
  );

  // 菜单打开时按 Escape 关闭。
  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menu]);

  /** 画布快捷键：撤销/重做、复制/粘贴、快速复制。输入框内不拦截。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (running) return;
      const selected = useWorkflowStore.getState().selectedNodeId;
      if (key === 'c') {
        if (copyNode(selected ?? undefined)) event.preventDefault();
      } else if (key === 'v') {
        event.preventDefault();
        pasteNode();
      } else if (key === 'd' && selected) {
        event.preventDefault();
        duplicateNode(selected);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [running, undo, redo, copyNode, pasteNode, duplicateNode]);

  const menuNode = menu ? nodes.find((node) => node.id === menu.nodeId) : undefined;

  return (
    <>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onPaneClick={() => selectNode(null)}
        onNodeContextMenu={onNodeContextMenu}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={!running}
        nodesConnectable={!running}
        deleteKeyCode={running ? null : ['Backspace', 'Delete']}
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

      {menu && (
        <>
          {/* 透明遮罩：点击任意处或按 Escape 关闭菜单 */}
          <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} />
          <div
            className="fixed z-50 min-w-32 rounded-md border border-border bg-popover p-1 shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                const nodeId = menu.nodeId;
                setMenu(null);
                void run(nodeId);
              }}
            >
              <Play className="size-3.5" />
              运行至此
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                const nodeId = menu.nodeId;
                setMenu(null);
                void cacheTo(nodeId);
              }}
            >
              <Snowflake className="size-3.5" />
              缓存至此
            </button>
            {cacheToken && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setMenu(null);
                  void clearCache();
                }}
              >
                <Unlock className="size-3.5" />
                取消缓存
              </button>
            )}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                const nodeId = menu.nodeId;
                setMenu(null);
                duplicateNode(nodeId);
              }}
            >
              <Copy className="size-3.5" />
              复制节点
            </button>
            <button
              type="button"
              disabled={cachedSet.has(menu.nodeId)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                const nodeId = menu.nodeId;
                setMenu(null);
                toggleNodeDisabled(nodeId);
              }}
            >
              {menuNode?.disabled ? (
                <>
                  <Power className="size-3.5" />
                  启用节点
                </>
              ) : (
                <>
                  <PowerOff className="size-3.5" />
                  禁用节点
                </>
              )}
            </button>
          </div>
        </>
      )}
    </>
  );
}
