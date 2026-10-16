import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../api.js';
import { useAuth } from '../auth.js';

interface ModelColumn {
  name: string;
  type: string;
}

interface ModelItem {
  name: string;
  sourceKind: 'csv' | 'excel' | 'sqlserver';
  sourceRef: {
    resourcePath?: string;
    format?: string;
    connectionId?: string;
    object?: string;
    query?: string;
  };
  ownerId: string | null;
  loadedAt: number;
  rowCount: number;
  columns: ModelColumn[];
}

const SOURCE_LABEL: Record<ModelItem['sourceKind'], string> = {
  csv: 'CSV 文件',
  excel: 'Excel 文件',
  sqlserver: 'SQL Server',
};

function sourceText(m: ModelItem): string {
  if (m.sourceKind === 'sqlserver') return m.sourceRef.object ?? m.sourceRef.query ?? '—';
  return m.sourceRef.resourcePath ?? '—';
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

export function ModelsPage() {
  const { hasCap } = useAuth();
  const canManage = hasCap('job');
  const [items, setItems] = useState<ModelItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: ModelItem[] }>('/api/models');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rename(m: ModelItem): Promise<void> {
    const next = window.prompt('新的模型名（字母或下划线开头，仅含字母数字下划线）', m.name);
    if (next === null) return;
    const newName = next.trim();
    if (!newName || newName === m.name) return;
    if (!window.confirm(`确认把模型「${m.name}」重命名为「${newName}」？已引用旧名的仪表板会失效。`)) return;
    try {
      await api.request('PATCH', `/api/models/${encodeURIComponent(m.name)}`, { body: { newName } });
      await load();
      window.alert(`已重命名为「${newName}」。注意：已引用旧名「${m.name}」的仪表板将失效。`);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function remove(m: ModelItem): Promise<void> {
    if (!window.confirm(`确认删除模型「${m.name}」？该操作不可恢复。`)) return;
    try {
      await api.del(`/api/models/${encodeURIComponent(m.name)}`);
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据模型</h1>
        <button
          className="rounded border px-3 py-1.5 text-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-sm text-slate-500">
        模型由 Job 编排中的「加载成模型」步骤产生；加载后可在仪表板中作为数据集使用。
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{loading ? '加载中…' : '暂无数据模型。'}</p>
      ) : (
        <table className="w-full border text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">模型名</th>
              <th className="p-2">来源</th>
              <th className="p-2">行数</th>
              <th className="p-2">列数</th>
              <th className="p-2">加载时间</th>
              {canManage && <th className="p-2">操作</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.name} className="border-t">
                <td className="p-2 font-mono">{m.name}</td>
                <td className="p-2">
                  {SOURCE_LABEL[m.sourceKind]}：{sourceText(m)}
                </td>
                <td className="p-2">{m.rowCount}</td>
                <td className="p-2">{m.columns.length}</td>
                <td className="p-2">{new Date(m.loadedAt).toLocaleString()}</td>
                {canManage && (
                  <td className="p-2">
                    <div className="flex gap-2">
                      <button className="rounded border px-2" onClick={() => void rename(m)}>
                        重命名
                      </button>
                      <button className="rounded border px-2 text-red-600" onClick={() => void remove(m)}>
                        删除
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
