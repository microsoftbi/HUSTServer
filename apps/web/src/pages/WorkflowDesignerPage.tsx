import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiClientError } from '../api';
import type { WorkflowConnectionNode, WorkflowDetail } from '../types';
import { WorkflowDesigner, type DesignerAdapter } from '@hustserver/workflow-designer';
import type {
  ColumnMeta,
  NodeResultEvent,
  NodeRunStatus,
  PreviewData,
  RunLogEvent,
  RunStatusEvent,
  Workflow,
} from '@hustserver/workflow-designer';

const MASKED = '******';
const SQL_KINDS = new Set(['inputSqlServer', 'outputSqlServer']);

interface RunSnapshot {
  run: { status: string };
  nodes: Array<{
    node_id: string;
    status: string;
    row_count: number | null;
    duration_ms: number | null;
    error: string | null;
  }>;
}

/** 平台侧运行状态 → 设计器运行状态。 */
function mapRunStatus(status: string): RunStatusEvent['status'] {
  if (status === 'success') return 'success';
  if (status === 'running' || status === 'pending' || status === 'queued') return 'running';
  return 'error';
}

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
        // 服务端存量 payload 只含 nodes/edges，不带 id；此处用详情响应的 id 补回，
        // 否则 store 的 workflowId 为空，「运行」按钮会被永久禁用。
        if (!cancelled) {
          setWorkflow({ ...hydrateWorkflow(detail.workflow, detail.name, connRes.nodes), id: detail.id });
        }
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
      // 资源管理器式浏览资源库目录；文件以绝对路径写回配置
      // （引擎对绝对路径原样读取，相对路径会按上传目录解析）。
      listResourceEntries: async (dir) => {
        const res = await api.get<{
          path: string;
          entries: Array<{ name: string; kind: 'folder' | 'file'; size?: number; absPath?: string }>;
        }>(`/api/resources?path=${encodeURIComponent(dir)}`);
        return {
          dir: res.path,
          entries: res.entries.map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            path: entry.kind === 'file' ? entry.absPath : undefined,
          })),
        };
      },
      // Excel 输入节点的工作表列表（后端限定资源库与上传目录内的文件）。
      listSheets: async (filePath) => {
        const res = await api.get<{ sheets: string[] }>(
          `/api/resources/sheets?path=${encodeURIComponent(filePath)}`,
        );
        return res.sheets;
      },
      // 输入节点结构探测：按节点类型映射到后端 schema 端点，返回列供下游面板下拉。
      probeSchema: async (kind, config) => {
        const endpoint =
          kind === 'inputCsv' ? 'csv' : kind === 'inputExcel' ? 'excel' : kind === 'inputSqlServer' ? 'sqlserver' : null;
        if (!endpoint) return [];
        const res = await api.post<{ columns: ColumnMeta[] }>(`/api/schema/${endpoint}`, {
          body: config,
        });
        return res.columns;
      },
      // 先保存再运行：把画布当前状态 PUT 回平台，随后触发一次手动运行。
      // targetNodeId 用于「运行至此」；freeze 用于「缓存至此」；cacheToken 用于复用既有缓存。
      runWorkflow: async (wf, targetNodeId?, options?) => {
        const workflowId = wf.id || (!isNew ? id : '') || '';
        if (!workflowId) throw new Error('请先保存工作流');
        await api.put(`/api/workflows/${workflowId}`, {
          body: { name: wf.name, workflow: stripMaskedPasswords(wf) },
        });
        const created = await api.post<{
          runId: string;
          cacheToken?: string;
          cachedNodeIds?: string[];
        }>(`/api/workflows/${workflowId}/runs`, {
          body: {
            ...(targetNodeId ? { targetNodeId } : {}),
            ...(options?.freeze ? { freeze: true } : {}),
            ...(options?.cacheToken ? { cacheToken: options.cacheToken } : {}),
          },
        });
        return {
          runId: created.runId,
          ...(created.cacheToken ? { cacheToken: created.cacheToken } : {}),
          ...(created.cachedNodeIds ? { cachedNodeIds: created.cachedNodeIds } : {}),
        };
      },
      // 「取消缓存」：解除服务端对冻结缓存的钉住。
      unpinCache: async (cacheToken) => {
        await api.del(`/api/runs/cache/${encodeURIComponent(cacheToken)}`);
      },
      // 订阅运行事件流；SSE 不重放历史事件，故在终态 / done 时用快照补齐。
      subscribeRun: (runId, handlers) => {
        const es = new EventSource(`/api/runs/${runId}/events`);
        let closed = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const parse = <T,>(raw: string): T | null => {
          try {
            return JSON.parse(raw) as T;
          } catch {
            return null;
          }
        };

        const stop = () => {
          if (closed) return;
          closed = true;
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
          }
          es.close();
          handlers.onDone?.();
        };

        // 用 /runs/:id 快照补齐事件流缺失的结果。运行刚触发时快照可能仍是 queued/running
        // （引擎会话尚未落库），此时不能当作已结束，需稍后重试，否则界面会卡在「运行中」。
        const settle = async () => {
          if (closed || retryTimer) return;
          try {
            const detail = await api.get<RunSnapshot>(`/api/runs/${runId}`);
            for (const node of detail.nodes) {
              handlers.onNodeResult?.({
                runId,
                type: 'node-result',
                nodeId: node.node_id,
                status: node.status as NodeRunStatus,
                rowCount: node.row_count ?? 0,
                durationMs: node.duration_ms ?? 0,
                error: node.error ?? undefined,
              });
            }
            const status = mapRunStatus(detail.run.status);
            handlers.onRunStatus?.({ runId, type: 'run-status', status });
            if (status === 'running') {
              retryTimer = setTimeout(() => {
                retryTimer = null;
                void settle();
              }, 300);
              return;
            }
          } catch {
            /* 快照拉取失败时以已收到的事件为准 */
          }
          stop();
        };

        es.addEventListener('log', (event) => {
          const payload = parse<RunLogEvent>((event as MessageEvent).data);
          if (payload) handlers.onLog?.(payload);
        });
        es.addEventListener('node-result', (event) => {
          const payload = parse<NodeResultEvent>((event as MessageEvent).data);
          if (payload) handlers.onNodeResult?.(payload);
        });
        es.addEventListener('run-status', (event) => {
          const payload = parse<RunStatusEvent>((event as MessageEvent).data);
          if (!payload) return;
          handlers.onRunStatus?.(payload);
          if (payload.status !== 'running') void settle();
        });
        es.addEventListener('done', () => void settle());
        // 连接断开时浏览器会自动重连，这里只上报错误，终态仍由 done / run-status 收尾。
        es.onerror = (error) => handlers.onError?.(error);

        return () => {
          closed = true;
          if (retryTimer) clearTimeout(retryTimer);
          es.close();
        };
      },
      // 读取节点输出预览（引擎在内存中保留运行会话，运行结束后仍可读取）。
      loadPreview: async (runId, nodeId, limit) => {
        const params = new URLSearchParams({ nodeId });
        if (limit !== undefined) params.set('limit', String(limit));
        try {
          return await api.get<PreviewData>(`/api/runs/${runId}/preview?${params.toString()}`);
        } catch (err) {
          // 409（节点未就绪 / 运行未开始）与 410（运行已过期）等以可读文案呈现。
          if (err instanceof ApiClientError) throw new Error(err.detail ?? err.code);
          throw err;
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
