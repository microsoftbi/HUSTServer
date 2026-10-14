import { basename, join } from 'node:path';
import type { Workflow, WorkflowNode } from '@hustserver/engine';
import type { PathMappingRow, WorkflowFileRow } from './repo.js';

export interface ResolvedConnection {
  id: string;
  config: Record<string, unknown>;
}

export interface MapperDeps {
  uploadDir: string;
  outputDir: string;
  resolveServerPath(rel: string): string;
  connections: Map<string, ResolvedConnection>;
  /** 工作流私有连接：node_id -> 明文连接配置（优先于全局连接映射）。 */
  workflowConnections?: Map<string, Record<string, unknown>>;
}

export interface BuildInput {
  workflow: Workflow;
  mappings: PathMappingRow[];
  files: WorkflowFileRow[];
  deps: MapperDeps;
  workflowId: string;
  runId: string;
}

export function buildRuntimeWorkflow(input: BuildInput): Workflow {
  const byNode = new Map<string, PathMappingRow>();
  for (const m of input.mappings) byNode.set(`${m.direction}:${m.node_id}`, m);

  const nodes: WorkflowNode[] = input.workflow.nodes.map((node) => {
    const config = { ...(node.config as Record<string, unknown>) };

    const inMap = byNode.get(`input:${node.id}`);
    if (inMap) {
      if (inMap.target_type === 'uploaded_file') {
        const stored = input.files.find((f) => f.node_id === node.id)?.stored_name ?? inMap.target_ref ?? '';
        config.path = join(input.deps.uploadDir, input.workflowId, stored);
      } else if (inMap.target_type === 'server_path') {
        config.path = input.deps.resolveServerPath(inMap.target_ref ?? '');
      } else if (inMap.target_type === 'connection') {
        const conn = input.deps.connections.get(inMap.target_ref ?? '');
        if (conn) config.connection = conn.config;
      }
    }

    const outMap = byNode.get(`output:${node.id}`);
    if (outMap && outMap.target_type === 'output_dir') {
      const name = basename(outMap.original_ref || 'output.csv');
      config.path = join(input.deps.outputDir, input.workflowId, input.runId, name);
    }

    // 工作流私有连接（来自 .htyx 内嵌配置）优先于全局连接映射。
    const privateConn = input.deps.workflowConnections?.get(node.id);
    if (privateConn) config.connection = privateConn;

    return { ...node, config };
  });

  return { ...input.workflow, nodes };
}
