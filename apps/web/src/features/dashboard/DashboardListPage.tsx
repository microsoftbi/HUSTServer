import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.js';
import { uid } from './lib/utils';
import type { DashboardPayload } from './types';

interface DashboardSummary {
  id: string;
  name: string;
  shared: boolean;
  owner_id: string | null;
  updated_at: number;
}

function makeInitialPayload(): DashboardPayload {
  const dash = { id: uid('dash'), name: '仪表盘 1', widgets: [] };
  return { version: 2, dashboards: [dash], activeId: dash.id, datasets: [] };
}

export function DashboardListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<DashboardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renameTarget, setRenameTarget] = useState<DashboardSummary | null>(null);
  const [renameName, setRenameName] = useState('');

  async function load() {
    try {
      setItems(await api.get<DashboardSummary[]>('/api/dashboards'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    const name = createName.trim();
    if (!name) return;
    try {
      const created = await api.post<DashboardSummary & { payload: DashboardPayload }>('/api/dashboards', {
        body: { name, payload: makeInitialPayload() },
      });
      setCreateOpen(false);
      setCreateName('');
      navigate(`/dashboards/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    await api.put(`/api/dashboards/${renameTarget.id}`, { body: { name } });
    setRenameTarget(null);
    await load();
  }

  async function remove(row: DashboardSummary) {
    if (!window.confirm(`确定删除仪表板「${row.name}」？`)) return;
    await api.del(`/api/dashboards/${row.id}`);
    await load();
  }

  async function toggleShared(row: DashboardSummary) {
    await api.put(`/api/dashboards/${row.id}`, { body: { shared: !row.shared } });
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">仪表板</h1>
        <button className="rounded bg-blue-600 px-3 py-1.5 text-white" onClick={() => setCreateOpen(true)}>
          新建仪表板
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">共享</th>
            <th className="p-2">更新时间</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">
                <Link className="text-blue-600 underline" to={`/dashboards/${row.id}`}>
                  {row.name}
                </Link>
              </td>
              <td className="p-2">{row.shared ? '是' : '否'}</td>
              <td className="p-2">{new Date(row.updated_at).toLocaleString()}</td>
              <td className="space-x-2 p-2">
                <Link className="text-blue-600 underline" to={`/dashboards/${row.id}`}>
                  打开
                </Link>
                <button
                  className="text-blue-600"
                  onClick={() => {
                    setRenameTarget(row);
                    setRenameName(row.name);
                  }}
                >
                  重命名
                </button>
                {user?.role === 'admin' && (
                  <button className="text-blue-600" onClick={() => void toggleShared(row)}>
                    {row.shared ? '取消共享' : '共享'}
                  </button>
                )}
                <button className="text-red-600" onClick={() => void remove(row)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={4}>
                暂无仪表板，点击右上角「新建仪表板」。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCreateOpen(false)}>
          <div className="w-full max-w-sm rounded bg-white p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-medium">新建仪表板</h2>
            <input
              className="mt-3 w-full rounded border px-3 py-1.5 text-sm"
              placeholder="仪表板名称"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-4 py-1.5" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={() => void create()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRenameTarget(null)}>
          <div className="w-full max-w-sm rounded bg-white p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-medium">重命名仪表板</h2>
            <input
              className="mt-3 w-full rounded border px-3 py-1.5 text-sm"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void rename()}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-4 py-1.5" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={() => void rename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
