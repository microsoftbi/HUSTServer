import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';

interface ConnectionDto {
  id: string;
  name: string;
  type: string;
  shared: boolean;
  owner_id: string | null;
  updated_at: number;
  config: Record<string, unknown>;
}

interface ConnectionForm {
  name: string;
  server: string;
  port: string;
  user: string;
  password: string;
  database: string;
  shared: boolean;
}

const EMPTY: ConnectionForm = { name: '', server: '', port: '1433', user: '', password: '', database: '', shared: false };

export function ConnectionsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState<ConnectionForm>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<ConnectionDto[]>('/api/connections'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(row: ConnectionDto) {
    setEditId(row.id);
    setNotice(null);
    setForm({
      name: row.name,
      server: String(row.config.server ?? ''),
      port: String(row.config.port ?? '1433'),
      user: String(row.config.user ?? ''),
      password: '',
      database: String(row.config.database ?? ''),
      shared: row.shared,
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const config: Record<string, unknown> = {
      server: form.server,
      port: Number(form.port) || 1433,
      user: form.user,
      database: form.database,
    };
    // 留空表示不修改密码（编辑时）
    if (form.password) config.password = form.password;
    try {
      if (editId) {
        await api.put(`/api/connections/${editId}`, {
          body: { name: form.name, config, shared: form.shared },
        });
      } else {
        await api.post('/api/connections', {
          body: { name: form.name, type: 'sqlserver', config, shared: form.shared },
        });
      }
      setForm(EMPTY);
      setEditId(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test(row: ConnectionDto) {
    setNotice(null);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; error?: string }>(`/api/connections/${row.id}/test`);
      setNotice(res.ok ? `连接「${row.name}」可达` : `连接「${row.name}」不可达：${res.error ?? '未知错误'}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: ConnectionDto) {
    if (!window.confirm(`确认删除连接「${row.name}」？`)) return;
    try {
      await api.del(`/api/connections/${row.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">数据连接</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-green-700">{notice}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">类型</th>
            <th className="p-2">服务器</th>
            <th className="p-2">库</th>
            <th className="p-2">共享</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{row.name}</td>
              <td className="p-2 text-slate-500">{row.type}</td>
              <td className="p-2">{String(row.config.server ?? '')}</td>
              <td className="p-2">{String(row.config.database ?? '')}</td>
              <td className="p-2">{row.shared ? '是' : '否'}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600 underline" onClick={() => void test(row)}>测试</button>
                <button className="text-blue-600 underline" onClick={() => startEdit(row)}>编辑</button>
                <button className="text-red-600 underline" onClick={() => void remove(row)}>删除</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={6}>暂无连接。</td>
            </tr>
          )}
        </tbody>
      </table>

      <form onSubmit={submit} className="grid max-w-2xl grid-cols-2 gap-3 rounded border p-4 text-sm">
        <label className="col-span-2 block">
          名称
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block">
          服务器
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.server}
            onChange={(e) => setForm({ ...form, server: e.target.value })}
            required
          />
        </label>
        <label className="block">
          端口
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
          />
        </label>
        <label className="block">
          用户
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.user}
            onChange={(e) => setForm({ ...form, user: e.target.value })}
          />
        </label>
        <label className="block">
          密码
          <input
            type="password"
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder={editId ? '留空则不修改' : ''}
          />
        </label>
        <label className="block">
          数据库
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.database}
            onChange={(e) => setForm({ ...form, database: e.target.value })}
          />
        </label>
        {isAdmin && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.shared}
              onChange={(e) => setForm({ ...form, shared: e.target.checked })}
            />
            共享给所有用户
          </label>
        )}
        <div className="col-span-2 flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
          >
            {editId ? '保存修改' : '新增连接'}
          </button>
          {editId && (
            <button
              type="button"
              className="rounded border px-4 py-1.5"
              onClick={() => {
                setEditId(null);
                setForm(EMPTY);
              }}
            >
              取消编辑
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
