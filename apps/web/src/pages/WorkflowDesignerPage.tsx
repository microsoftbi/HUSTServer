import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { WorkflowConnectionNode, WorkflowDetail } from '../types';
import { WorkflowDesigner, type DesignerAdapter } from '@hustserver/workflow-designer';
import type { Workflow } from '@hustserver/workflow-designer';

const MASKED = '******';
const SQL_KINDS = new Set(['inputSqlServer', 'outputSqlServer']);

function blankWorkflow(): Workflow {
  const now = Date.now();
  return { id: '', name: '未命名工作流', nodes: [], edges: [], createdAt: now, updatedAt: now };
}

/** 把平台留存的（掩码）连接合并进 SQL 节点配置；补 name 兜底。 */
function hydrateWorkflow(raw: unknown, name: string, connections: WorkflowConnectionNode[]): Workflow {
  const wf = raw as Workflow;
  const byNode = new Map(connections.map((c) => [c.node_id, c] as const));
  return {
    ...wf,
    name: wf.name || name || '未命名工作流',
    nodes: wf.nodes.map((node) => {
      if (!SQL_KINDS.has(node.kind)) return node;
      const remote = byNode.get(node.id);
      if (!remote?.config) return node;
      const config = node.config as Record<string, unknown>;
      return {
        ...node,
        config: { ...config, connection: { ...((config.connection as object) ?? {}), ...remote.config } },
      };
    }),
  };
}

/** 发送前清洗掩码密码哨兵：'******' → ''（空 = 沿用原值，服务端 mergeConnectionConfig 处理）。 */
function stripMaskedPasswords(wf: Workflow): Workflow {
  return {
    ...wf,
    nodes: wf.nodes.map((node) => {
      if (!SQL_KINDS.has(node.kind)) return node;
      const config = { ...(node.config as Record<string, unknown>) };
      const conn = { ...((config.connection as Record<string, unknown>) ?? {}) };
      if (conn.password === MASKED) conn.password = '';
      config.connection = conn;
      return { ...node, config };
    }),
  };
}

export function WorkflowDesignerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('dark');
    return () => document.documentElement.classList.remove('dark');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (isNew) {
      setWorkflow(blankWorkflow());
      return;
    }
    Promise.all([
      api.get<WorkflowDetail>(`/api/workflows/${id}`),
      api.get<{ nodes: WorkflowConnectionNode[] }>(`/api/workflows/${id}/connections`),
    ])
      .then(([detail, connRes]) => {
        if (!cancelled) setWorkflow(hydrateWorkflow(detail.workflow, detail.name, connRes.nodes));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  const adapter = useMemo<DesignerAdapter>(
    () => ({
      onSave: async (wf) => {
        const payload = stripMaskedPasswords(wf);
        if (isNew) {
          const created = await api.post<{ id: string }>('/api/workflows', {
            body: { name: wf.name, workflow: payload },
          });
          navigate(`/workflows/${created.id}/designer`, { replace: true });
        } else {
          await api.put(`/api/workflows/${id}`, { body: { name: wf.name, workflow: payload } });
        }
      },
    }),
    [id, isNew, navigate],
  );

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center gap-3 text-sm">
        <span className="text-red-500">{error}</span>
        <button className="underline" onClick={() => navigate('/workflows')}>返回列表</button>
      </div>
    );
  }
  if (!workflow) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <WorkflowDesigner
      initialWorkflow={workflow}
      adapter={adapter}
      onExit={() => navigate(isNew ? '/workflows' : `/workflows/${id}`)}
    />
  );
}
