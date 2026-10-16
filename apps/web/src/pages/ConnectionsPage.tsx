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
  const { hasCap } = useAuth();
  const isAdmin = hasCap('admin');
  const [rows, setRows] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState<ConnectionForm>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msgBox, setMsgBox] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbTested, setDbTested] = useState(false);

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

  function resetTest() {
    setTestResult(null);
    setDatabases([]);
    setDbTested(false);
  }

  function openCreate() {
    setEditId(null);
    setForm(EMPTY);
    setFormError(null);
    resetTest();
    setModalOpen(true);
  }

  function openEdit(row: ConnectionDto) {
    setEditId(row.id);
    setForm({
      name: row.name,
      server: String(row.config.server ?? ''),
      port: String(row.config.port ?? '1433'),
      user: String(row.config.user ?? ''),
      password: '',
      database: String(row.config.database ?? ''),
      shared: row.shared,
    });
    setFormError(null);
    resetTest();
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditId(null);
    setForm(EMPTY);
    setFormError(null);
    resetTest();
  }

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setModalOpen(false);
      setEditId(null);
      setForm(EMPTY);
      setFormError(null);
      setTestResult(null);
      setDatabases([]);
      setDbTested(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  useEffect(() => {
    if (!msgBox) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMsgBox(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [msgBox]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
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
      setModalOpen(false);
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testDraft() {
    setFormError(null);
    setTestResult(null);
    setDatabases([]);
    setDbTested(false);
    setTesting(true);
    const config: Record<string, unknown> = {
      server: form.server,
      port: Number(form.port) || 1433,
      user: form.user,
      database: form.database,
    };
    if (form.password) config.password = form.password;
    try {
      const res = await api.post<{ ok: boolean; databases?: string[]; error?: string }>(
        '/api/connections/test',
        { body: { config } },
      );
      if (res.ok) {
        const list = res.databases ?? [];
        setDatabases(list);
        setDbTested(true);
        setForm((f) => ({ ...f, database: list.includes(f.database) ? f.database : (list[0] ?? '') }));
        setTestResult({ ok: true, msg: `连接可达，已读取 ${list.length} 个数据库` });
      } else {
        setTestResult({ ok: false, msg: `连接不可达：${res.error ?? '未知错误'}` });
      }
    } catch (err) {
      setTestResult({ ok: false, msg: `测试失败：${(err as Error).message}` });
    } finally {
      setTesting(false);
    }
  }

  async function test(row: ConnectionDto) {
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; error?: string }>(`/api/connections/${row.id}/test`);
      setMsgBox(
        res.ok
          ? { ok: true, msg: `连接「${row.name}」可达` }
          : { ok: false, msg: `连接「${row.name}」不可达：${res.error ?? '未知错误'}` },
      );
    } catch (err) {
      setMsgBox({ ok: false, msg: `测试失败：${(err as Error).message}` });
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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据连接</h1>
        <button
          className="rounded bg-blue-600 px-4 py-1.5 text-white"
          onClick={openCreate}
        >
          新建连接
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

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
                <button className="text-blue-600 underline" onClick={() => openEdit(row)}>编辑</button>
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

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeModal}>
          <form
            onSubmit={submit}
            className="grid w-full max-w-2xl grid-cols-2 gap-3 rounded bg-white p-4 text-sm shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="col-span-2 font-medium">{editId ? '编辑连接' : '新建连接'}</h2>
            {formError && <p className="col-span-2 text-sm text-red-600">{formError}</p>}
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
            <div className="col-span-2 flex items-center gap-3">
              <button
                type="button"
                className="rounded border px-4 py-1.5 disabled:opacity-50"
                onClick={() => void testDraft()}
                disabled={testing || busy}
              >
                {testing ? '测试中…' : '测试连接'}
              </button>
              {testResult && (
                <span className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
                  {testResult.msg}
                </span>
              )}
            </div>
            <label className="block">
              数据库
              <select
                className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100 disabled:text-slate-500"
                value={form.database}
                onChange={(e) => setForm({ ...form, database: e.target.value })}
                disabled={!dbTested}
              >
                {dbTested ? (
                  databases.map((db) => (
                    <option key={db} value={db}>{db}</option>
                  ))
                ) : (
                  <option value={form.database}>{form.database || '请先测试连接'}</option>
                )}
              </select>
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
            <div className="col-span-2 flex items-center justify-end gap-2">
              <button type="button" className="rounded border px-4 py-1.5" onClick={closeModal}>取消</button>
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
              >
                {editId ? '保存修改' : '新增'}
              </button>
            </div>
          </form>
        </div>
      )}

      {msgBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMsgBox(null)}>
          <div
            className="w-full max-w-sm rounded bg-white p-4 text-sm shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-medium">测试连接</h2>
            <p className={`mt-2 ${msgBox.ok ? 'text-green-700' : 'text-red-600'}`}>{msgBox.msg}</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded bg-blue-600 px-4 py-1.5 text-white"
                onClick={() => setMsgBox(null)}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
