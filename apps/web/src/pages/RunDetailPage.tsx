import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { RunSummary } from '../types.js';

interface RunNodeResult {
  id: number;
  run_id: string;
  node_id: string;
  name: string | null;
  kind: string | null;
  status: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  updated_at: number;
}

interface LogItem {
  id: number;
  ts: number;
  level: string;
  node_id: string | null;
  message: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过',
};

export function RunDetailPage() {
  const { id = '' } = useParams();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [nodes, setNodes] = useState<RunNodeResult[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // SSE 的 log 事件无自增 id，前端用本地计数器生成稳定 key
  const nextLogId = useRef(0);

  const loadSnapshot = useCallback(async () => {
    try {
      const [detail, logRes] = await Promise.all([
        api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`),
        api.get<{ items: LogItem[] }>(`/api/runs/${id}/logs?limit=1000`),
      ]);
      setRun(detail.run);
      setNodes(detail.nodes);
      setLogs(logRes.items);
      nextLogId.current = logRes.items.reduce((max, l) => Math.max(max, l.id), 0) + 1;
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  const refreshDetail = useCallback(async () => {
    try {
      const detail = await api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`);
      setRun(detail.run);
      setNodes(detail.nodes);
    } catch {
      /* 忽略瞬时错误，done 时会再拉一次完整快照 */
    }
  }, [id]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  // 无论运行是否已结束都订阅：已结束时服务端立即下发 done 并关闭连接。
  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/events`);
    setLive(true);

    es.addEventListener('log', (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as {
        level: string;
        nodeId?: string;
        message: string;
        ts: number;
      };
      setLogs((prev) => [
        ...prev,
        { id: nextLogId.current++, ts: e.ts, level: e.level, node_id: e.nodeId ?? null, message: e.message },
      ]);
    });
    // node-result / run-status 的具体字段由引擎定义，直接回拉快照最稳妥
    es.addEventListener('node-result', () => void refreshDetail());
    es.addEventListener('run-status', () => void refreshDetail());
    es.addEventListener('done', () => {
      setLive(false);
      es.close();
      void loadSnapshot();
    });
    es.onerror = () => {
      setLive(false);
      es.close();
    };

    return () => es.close();
  }, [id, loadSnapshot, refreshDetail]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">运行详情</h1>
        <span className="text-sm text-slate-500">
          {run ? STATUS_LABEL[run.status] ?? run.status : '加载中…'}
        </span>
        {live && <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">实时</span>}
        <Link className="ml-auto text-sm text-blue-600 underline" to={`/workflows/${run?.workflow_id ?? ''}`}>
          返回工作流
        </Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {run?.error && <p className="text-sm text-red-600">错误：{run.error}</p>}

      <section className="space-y-2">
        <h2 className="font-medium">节点结果</h2>
        <table className="w-full border text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">节点</th>
              <th className="p-2">类型</th>
              <th className="p-2">状态</th>
              <th className="p-2">行数</th>
              <th className="p-2">耗时</th>
              <th className="p-2">错误</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.node_id} className="border-t">
                <td className="p-2">{n.name ?? n.node_id}</td>
                <td className="p-2 text-slate-500">{n.kind ?? '-'}</td>
                <td className="p-2">{STATUS_LABEL[n.status] ?? n.status}</td>
                <td className="p-2">{n.row_count ?? '-'}</td>
                <td className="p-2">{n.duration_ms != null ? `${n.duration_ms} ms` : '-'}</td>
                <td className="p-2 text-red-600">{n.error ?? ''}</td>
              </tr>
            ))}
            {nodes.length === 0 && (
              <tr>
                <td className="p-2 text-slate-500" colSpan={6}>暂无节点结果。</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">日志</h2>
        <div className="max-h-96 overflow-auto rounded border bg-slate-900 p-3 font-mono text-xs text-slate-100">
          {logs.map((l) => (
            <div key={l.id}>
              <span className="text-slate-400">[{new Date(l.ts).toLocaleTimeString()}]</span>{' '}
              <span className={l.level === 'error' ? 'text-red-400' : 'text-slate-300'}>{l.level}</span>{' '}
              {l.node_id && <span className="text-blue-300">{l.node_id} </span>}
              <span>{l.message}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-slate-500">暂无日志。</div>}
        </div>
      </section>
    </div>
  );
}
