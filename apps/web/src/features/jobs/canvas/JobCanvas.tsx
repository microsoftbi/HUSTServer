import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, useReactFlow, useViewport,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange,
} from '@xyflow/react';
import {
  Copy, CopyPlus, MousePointerClick, Play, Power, PowerOff, SkipForward, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { JobNodeMode, JobStepType } from '../../../types.js';
import { useCanvasTheme } from '../../theme/themeStore.js';
import { disabledKeys } from '../lib/graph.js';
import { describeNode, JOB_NODE_META, nodeIssues, type NodeLookups } from '../lib/nodeMeta.js';
import { useJobEditorStore } from '../store/jobEditorStore.js';
import { JOB_NODE_DND } from './JobPalette.js';
import { jobNodeTypes, type JobNodeData, type JobNodeStatus } from './JobNodeCard.js';

const MINIMAP_COLOR: Record<JobStepType, string> = {
  workflow: '#0ea5e9',
  sql: '#8b5cf6',
  load_model: '#10b981',
};

const EDGE_COLOR: Partial<Record<JobNodeStatus, string>> = {
  running: 'var(--warning)',
  success: 'var(--success)',
  error: 'var(--destructive)',
  canceled: 'var(--warning)',
};

const edgeId = (source: string, target: string): string => `${source}->${target}`;

/** 画布默认缩放比例：空画布与节点较少时都以 80% 显示，超出视口时才自动缩小。 */
const DEFAULT_ZOOM = 0.8;

export function JobCanvas({
  lookups,
  statuses,
  locked = false,
}: {
  lookups: NodeLookups;
  /** 运行中按 steps[].node_key 着色的状态表。 */
  statuses?: Map<string, JobNodeStatus>;
  locked?: boolean;
}) {
  const nodes = useJobEditorStore((s) => s.nodes);
  const edges = useJobEditorStore((s) => s.edges);
  const selectedKey = useJobEditorStore((s) => s.selectedKey);
  const addNode = useJobEditorStore((s) => s.addNode);
  const addEdge = useJobEditorStore((s) => s.addEdge);
  const removeNodes = useJobEditorStore((s) => s.removeNodes);
  const removeEdges = useJobEditorStore((s) => s.removeEdges);
  const select = useJobEditorStore((s) => s.select);
  const moveNodes = useJobEditorStore((s) => s.moveNodes);
  const beginDrag = useJobEditorStore((s) => s.beginDrag);
  const endDrag = useJobEditorStore((s) => s.endDrag);
  const updateNode = useJobEditorStore((s) => s.updateNode);
  const copyNode = useJobEditorStore((s) => s.copyNode);
  const pasteNode = useJobEditorStore((s) => s.pasteNode);
  const duplicateNode = useJobEditorStore((s) => s.duplicateNode);
  const undo = useJobEditorStore((s) => s.undo);
  const redo = useJobEditorStore((s) => s.redo);

  const { screenToFlowPosition } = useReactFlow();
  const { colorMode } = useCanvasTheme();

  /**
   * 受控模式下 React Flow 不会把 `measured` 写回外部节点对象，
   * MiniMap 只渲染带尺寸的节点，因此自行保存并回填。
   */
  const [nodeDimensions, setNodeDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});

  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);

  const disabled = useMemo(() => disabledKeys(nodes, edges), [nodes, edges]);

  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => {
        const measured = nodeDimensions[node.key];
        return {
          id: node.key,
          type: 'job',
          position: { x: node.x, y: node.y },
          selected: node.key === selectedKey,
          draggable: !locked,
          ...(measured ? { measured } : {}),
          data: {
            node,
            summary: describeNode(node, lookups),
            issues: nodeIssues(node),
            status: statuses?.get(node.key) ?? 'idle',
            upstreamDisabled: node.mode !== 'disable' && disabled.has(node.key),
            locked,
          } satisfies JobNodeData,
        };
      }),
    [nodes, nodeDimensions, selectedKey, lookups, disabled, locked, statuses],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const status = statuses?.get(edge.source) ?? 'idle';
        const color = EDGE_COLOR[status];
        return {
          id: edgeId(edge.source, edge.target),
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          animated: status === 'running',
          style: { strokeWidth: 2, ...(color ? { stroke: color } : {}) },
        };
      }),
    [edges, statuses],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const measuredUpdates: Record<string, { width: number; height: number }> = {};
      const positionUpdates: Record<string, { x: number; y: number }> = {};
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (locked) continue;
          positionUpdates[change.id] = change.position;
        } else if (change.type === 'remove') {
          if (locked) continue;
          removeNodes([change.id]);
        } else if (change.type === 'select' && change.selected) {
          select(change.id);
        } else if (change.type === 'dimensions' && change.dimensions) {
          measuredUpdates[change.id] = change.dimensions;
        }
      }
      if (Object.keys(positionUpdates).length > 0) moveNodes(positionUpdates);
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
    [locked, removeNodes, select, moveNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (locked) return;
      const removed = changes
        .filter((change) => change.type === 'remove')
        .map((change) => {
          const edge = edges.find((item) => edgeId(item.source, item.target) === change.id);
          return edge ? { source: edge.source, target: edge.target } : null;
        })
        .filter((edge): edge is { source: string; target: string } => edge !== null);
      removeEdges(removed);
    },
    [edges, locked, removeEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (locked || !connection.source || !connection.target) return;
      const result = addEdge(connection.source, connection.target);
      if (!result.ok) toast.error(result.reason);
    },
    [addEdge, locked],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (locked) return;
      const type = event.dataTransfer.getData(JOB_NODE_DND) as JobStepType;
      if (!type || !JOB_NODE_META[type]) return;
      addNode(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addNode, locked, screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      if (locked) return;
      select(node.id);
      setMenu({ key: node.id, x: event.clientX, y: event.clientY });
    },
    [locked, select],
  );

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
      if (locked) return;
      const selected = useJobEditorStore.getState().selectedKey;
      if (key === 'c') {
        if (selected && copyNode(selected)) event.preventDefault();
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
  }, [locked, undo, redo, copyNode, pasteNode, duplicateNode]);

  const menuNode = menu ? nodes.find((node) => node.key === menu.key) : undefined;

  const setMode = (key: string, mode: JobNodeMode) => updateNode(key, { mode });

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
        onPaneClick={() => select(null)}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDragStart={beginDrag}
        onNodeDragStop={endDrag}
        nodeTypes={jobNodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ maxZoom: DEFAULT_ZOOM, padding: 0.2 }}
        defaultViewport={{ x: 0, y: 0, zoom: DEFAULT_ZOOM }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={!locked}
        nodesConnectable={!locked}
        deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
        defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls className="!rounded-md !border !border-border !bg-card !shadow-md" />
        <Panel position="bottom-right" className="!m-3 flex flex-col items-end gap-1">
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => {
              const data = node.data as unknown as JobNodeData | undefined;
              return data?.node ? MINIMAP_COLOR[data.node.type] : '#64748b';
            }}
            maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
            className="!static !m-0 !rounded-md !border !border-border !bg-card"
          />
          <ZoomBadge />
        </Panel>
        {nodes.length === 0 && (
          <Panel position="top-center" className="pointer-events-none mt-24">
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card/70 px-6 py-5 text-center">
              <MousePointerClick className="size-6 text-muted-foreground" />
              <div className="text-sm font-medium">从顶部 Ribbon 拖入组件开始编排</div>
              <div className="text-xs text-muted-foreground">
                连线表示依赖：下游节点等待上游节点完成后执行
              </div>
            </div>
          </Panel>
        )}
      </ReactFlow>

      {menu && menuNode && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} />
          <div
            className="fixed z-50 min-w-36 rounded-md border border-border bg-popover p-1 shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setMenu(null);
                select(menuNode.key);
              }}
            >
              <Play className="size-3.5" />
              配置节点
            </button>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              disabled={menuNode.mode === 'skip'}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                setMenu(null);
                setMode(menuNode.key, 'skip');
              }}
            >
              <SkipForward className="size-3.5" />
              设为跳过
            </button>
            <button
              type="button"
              disabled={menuNode.mode === 'disable'}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                setMenu(null);
                setMode(menuNode.key, 'disable');
              }}
            >
              <PowerOff className="size-3.5" />
              设为禁用（下游一起）
            </button>
            <button
              type="button"
              disabled={menuNode.mode === 'run'}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                setMenu(null);
                setMode(menuNode.key, 'run');
              }}
            >
              <Power className="size-3.5" />
              恢复为正常
            </button>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setMenu(null);
                copyNode(menuNode.key);
              }}
            >
              <Copy className="size-3.5" />
              复制
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setMenu(null);
                duplicateNode(menuNode.key);
              }}
            >
              <CopyPlus className="size-3.5" />
              复制节点
            </button>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
              onClick={() => {
                setMenu(null);
                removeNodes([menuNode.key]);
              }}
            >
              <Trash2 className="size-3.5" />
              删除节点
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** 鹰眼视图下方的当前缩放比例，随画布缩放实时更新。 */
function ZoomBadge() {
  const { zoom } = useViewport();
  return (
    <div className="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground shadow-md">
      {Math.round(zoom * 100)}%
    </div>
  );
}
