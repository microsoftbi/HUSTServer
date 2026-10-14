import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { WorkflowConnectionNode } from '../types.js';

interface ConnForm {
  server: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

const EMPTY: ConnForm = { server: '', port: '1433', user: '', password: '', database: '' };

export function WorkflowConnectionsPage() {
  const { id = '' } = useParams();
  const [nodes, setNodes] = useState<WorkflowConnectionNode[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ nodes: WorkflowConnectionNode[] }>(`/api/workflows/${id}/connections`);
      setNodes(res.nodes);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(node: WorkflowConnectionNode) {
    setEditId(node.node_id);
    setNotice(null);
    const cfg = node.config ?? {};
    setForm({
      server: String(cfg.server ?? ''),
      port: String(cfg.port ?? '1433'),
      user: String(cfg.user ?? ''),
      password: '',
      database: String(cfg.database ?? ''),
    });
  }

  async function test() {
    if (!editId) return;
    setNotice(null);
    setError(null);
    const config: Record<string, unknown> = {
      server: form.server,
      port: Number(form.port) || 1433,
      user: form.user,
      database: form.database,
    };
    if (form.password) config.password = form.password;
    try {
      const res = await api.post<{ ok: boolean; error?: string }>(
        `/api/workflows/${id}/connections/${editId}/test`,
        { body: { config } },
      );
      setNotice(res.ok ? '连接可达' : `连接不可达：${res.error ?? '未知错误'}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const config: Record<string, unknown> = {
      server: form.server,
      port: Number(form.port) || 1433,
      user: form.user,
      database: form.database,
    };
    // 留空表示不修改密码
    if (form.password) config.password = form.password;
    try {
      await api.put(`/api/workflows/${id}/connections/${editId}`, { body: { config } });
      setEditId(null);
      setForm(EMPTY);
      setNotice('已保存');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据连接</h1>
        <Link className="text-blue-600 underline" to="/workflows">
          返回工作流列表
        </Link>
      </div>
      <p className="text-sm text-slate-500">
        仅可配置该工作流内的 SQL Server 输入/输出节点连接。未修改的节点默认使用工作流文件中的配置。
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-green-700">{notice}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">节点</th>
            <th className="p-2">类型</th>
            <th className="p-2">服务器</th>
            <th className="p-2">库</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.node_id} className="border-t">
              <td className="p-2">{node.name ?? node.node_id}</td>
              <td className="p-2 text-slate-500">{node.kind}</td>
              <td className="p-2">{String(node.config?.server ?? '')}</td>
              <td className="p-2">{String(node.config?.database ?? '')}</td>
              <td className="p-2">
                <button className="text-blue-600 underline" onClick={() => startEdit(node)}>
                  编辑
                </button>
              </td>
            </tr>
          ))}
          {nodes.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={5}>
                该工作流没有可配置的 SQL Server 节点。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editId && (
        <form onSubmit={submit} className="grid max-w-2xl grid-cols-2 gap-3 rounded border p-4 text-sm">
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
              placeholder="留空则不修改"
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
          <div className="col-span-2 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
            >
              保存修改
            </button>
            <button
              type="button"
              className="rounded border px-4 py-1.5"
              onClick={() => void test()}
            >
              测试连接
            </button>
            <button
              type="button"
              className="rounded border px-4 py-1.5"
              onClick={() => {
                setEditId(null);
                setForm(EMPTY);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
