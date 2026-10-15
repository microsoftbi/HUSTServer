import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { MappingTargetType, RunSummary, WorkflowDetail } from '../types.js';

const TARGET_LABEL: Record<MappingTargetType, string> = {
  uploaded_file: '上传的数据文件',
  server_path: '服务端路径',
  connection: '连接',
  output_dir: '服务端输出目录',
  resource: '资源库文件',
};

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

export function WorkflowDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([
        api.get<WorkflowDetail>(`/api/workflows/${id}`),
        api.get<{ items: RunSummary[] }>(`/api/workflows/${id}/runs?limit=20`),
      ]);
      setDetail(d);
      setRuns(r.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setBusy(true);
    try {
      const res = await api.post<{ runId: string }>(`/api/workflows/${id}/runs`);
      navigate(`/runs/${res.runId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadData(nodeId: string, file: File) {
    const form = new FormData();
    form.append('nodeId', nodeId);
    form.append('file', file);
    try {
      await api.post(`/api/workflows/${id}/files`, { form });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error && !detail) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{detail.name}</h1>
        <div className="flex gap-2">
          <Link className="rounded bg-green-600 px-4 py-1.5 text-white" to={`/workflows/${id}/designer`}>
            编辑画布
          </Link>
          <button
            className="rounded bg-green-600 px-4 py-1.5 text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void runNow()}
          >
            {busy ? '提交中…' : '立即运行'}
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="font-medium">输入绑定</h2>
        {detail.mappings.filter((m) => m.direction === 'input').length === 0 && (
          <p className="text-sm text-slate-500">无输入绑定。</p>
        )}
        {detail.mappings
          .filter((m) => m.direction === 'input')
          .map((m) => {
            const file = detail.files.find((f) => f.node_id === m.node_id);
            return (
              <div key={m.node_id} className="space-y-1 rounded border p-3 text-sm">
                <div>
                  <span className="text-slate-500">{m.original_ref}</span>
                  <span className="mx-2">→</span>
                  <span className="font-medium">{TARGET_LABEL[m.target_type]}</span>
                  {m.target_type === 'uploaded_file' && file && (
                    <span className="ml-2 text-slate-500">
                      {file.stored_name}（{file.size} 字节）
                    </span>
                  )}
                  {m.target_type !== 'uploaded_file' && m.target_ref && (
                    <span className="ml-2 text-slate-500">{m.target_ref}</span>
                  )}
                </div>
                <label className="block text-slate-600">
                  重新上传数据文件：
                  <input
                    className="ml-2"
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadData(m.node_id, f);
                    }}
                  />
                </label>
              </div>
            );
          })}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">输出</h2>
        {detail.mappings.filter((m) => m.direction === 'output').length === 0 && (
          <p className="text-sm text-slate-500">无输出绑定。</p>
        )}
        {detail.mappings
          .filter((m) => m.direction === 'output')
          .map((m) => (
            <p key={m.node_id} className="text-sm text-slate-600">
              {m.original_ref} → {TARGET_LABEL[m.target_type]}
            </p>
          ))}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">运行历史</h2>
        <table className="w-full border text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">时间</th>
              <th className="p-2">触发</th>
              <th className="p-2">状态</th>
              <th className="p-2">耗时</th>
              <th className="p-2">详情</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-t">
                <td className="p-2">{new Date(run.created_at).toLocaleString()}</td>
                <td className="p-2">{run.trigger_type}</td>
                <td className="p-2">{STATUS_LABEL[run.status] ?? run.status}</td>
                <td className="p-2">{run.duration_ms != null ? `${run.duration_ms} ms` : '-'}</td>
                <td className="p-2">
                  <Link className="text-blue-600 underline" to={`/runs/${run.id}`}>
                    查看日志
                  </Link>
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="p-2 text-slate-500" colSpan={5}>
                  暂无运行记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
