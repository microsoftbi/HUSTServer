import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { WorkflowSummary } from '../types.js';

export function WorkflowListPage() {
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.get<WorkflowSummary[]>('/api/workflows'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string, name: string) {
    if (!window.confirm(`确定删除工作流「${name}」？其运行记录将一并删除。`)) return;
    await api.del(`/api/workflows/${id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">工作流</h1>
        <div className="flex gap-2">
          <Link className="rounded bg-blue-600 px-3 py-1.5 text-white" to="/workflows/new">
            上传工作流
          </Link>
          <Link className="rounded bg-blue-600 px-3 py-1.5 text-white" to="/workflows/new/designer">
            新建画布
          </Link>
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">更新时间</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id} className="border-t">
              <td className="p-2">
                <Link className="text-blue-600 underline" to={`/workflows/${w.id}`}>
                  {w.name}
                </Link>
              </td>
              <td className="p-2">{new Date(w.updated_at).toLocaleString()}</td>
              <td className="space-x-2 p-2">
                <Link className="text-blue-600 underline" to={`/workflows/${w.id}/connections`}>
                  数据连接
                </Link>
                <Link className="text-blue-600 underline" to={`/workflows/${w.id}/designer`}>
                  编辑画布
                </Link>
                <button className="text-red-600" onClick={() => void remove(w.id, w.name)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={3}>
                暂无工作流，点击右上角「上传工作流」。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
