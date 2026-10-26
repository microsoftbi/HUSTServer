import { useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, Controls, ReactFlow,
  type Edge, type Node,
} from '@xyflow/react';
import type { JobGraphSnapshot, JobStepRunSummary } from '../../../types.js';
import { useCanvasTheme } from '../../theme/themeStore.js';
import { disabledKeys } from '../lib/graph.js';
import { jobNodeTypes, type JobNodeData, type JobNodeStatus } from './JobNodeCard.js';

const STEP_STATUS: Record<JobStepRunSummary['status'], JobNodeStatus> = {
  pending: 'pending',
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
  canceled: 'canceled',
};

const EDGE_COLOR: Partial<Record<JobNodeStatus, string>> = {
  running: 'var(--warning)',
  success: 'var(--success)',
  error: 'var(--destructive)',
  canceled: 'var(--warning)',
};

function statusSummary(node: JobGraphSnapshot['nodes'][number], step: JobStepRunSummary | undefined): string {
  if (!step) return '未执行';
  if (step.status === 'pending') return '等待上游完成';
  if (step.status === 'running') return '执行中…';
  if (step.status === 'skipped') return '已跳过';
  if (step.status === 'canceled') return '已取消';
  const seconds = step.duration_ms != null ? ` · ${(step.duration_ms / 1000).toFixed(1)}s` : '';
  if (step.status === 'error') return `失败${step.error ? `：${step.error}` : ''}`;
  if (node.type === 'sql') return `完成${seconds}`;
  return `完成${seconds}`;
}

/** 运行详情只读画布：按 `steps[].node_key` 着色，边随源节点状态。 */
export function JobRunCanvas({ graph, steps }: { graph: JobGraphSnapshot; steps: JobStepRunSummary[] }) {
  // 只读画布位于普通列表页内，主题只作用于画布容器，不外泄到整页。
  const { theme, colorMode } = useCanvasTheme();
  const [nodeDimensions, setNodeDimensions] = useState<
    Record<string, { width: number; height: number }>
  >({});

  const stepByKey = useMemo(() => {
    const map = new Map<string, JobStepRunSummary>();
    for (const step of steps) {
      if (step.node_key) map.set(step.node_key, step);
    }
    return map;
  }, [steps]);

  const statusByKey = useMemo(() => {
    const map = new Map<string, JobNodeStatus>();
    for (const node of graph.nodes) {
      const step = stepByKey.get(node.key);
      map.set(node.key, step ? STEP_STATUS[step.status] : 'idle');
    }
    return map;
  }, [graph.nodes, stepByKey]);

  const disabled = useMemo(() => disabledKeys(graph.nodes, graph.edges), [graph.nodes, graph.edges]);

  const rfNodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node) => {
        const measured = nodeDimensions[node.key];
        const step = stepByKey.get(node.key);
        return {
          id: node.key,
          type: 'job',
          position: { x: node.x, y: node.y },
          draggable: false,
          ...(measured ? { measured } : {}),
          data: {
            node,
            summary: statusSummary(node, step),
            issues: [],
            status: statusByKey.get(node.key) ?? 'idle',
            upstreamDisabled: node.mode !== 'disable' && disabled.has(node.key),
            locked: true,
          } satisfies JobNodeData,
        };
      }),
    [graph.nodes, nodeDimensions, stepByKey, statusByKey, disabled],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const status = statusByKey.get(edge.source) ?? 'idle';
        const color = EDGE_COLOR[status];
        return {
          id: `${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          animated: status === 'running',
          style: { strokeWidth: 2, ...(color ? { stroke: color } : {}) },
        };
      }),
    [graph.edges, statusByKey],
  );

  return (
    <div
      className="h-96 overflow-hidden rounded-md border border-border bg-background"
      data-canvas-theme={theme}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={(changes) => {
          const measured = changes.filter(
            (change) => change.type === 'dimensions' && change.dimensions,
          );
          if (measured.length === 0) return;
          setNodeDimensions((prev) => {
            const next = { ...prev };
            for (const change of measured) {
              if (change.type === 'dimensions' && change.dimensions) {
                next[change.id] = change.dimensions;
              }
            }
            return next;
          });
        }}
        nodeTypes={jobNodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ maxZoom: 0.8, padding: 0.2 }}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls className="!rounded-md !border !border-border !bg-card !shadow-md" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
