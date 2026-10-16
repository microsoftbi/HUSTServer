import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { ROLE_LABELS, ROLES, type Role } from '../roles.js';

interface UserDto {
  id: string;
  username: string;
  roles: Role[];
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

const EMPTY_FORM = { username: '', password: '', confirmPassword: '', roles: [] as Role[] };

export function UsersPage() {
  const { hasCap } = useAuth();
  const [rows, setRows] = useState<UserDto[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<UserDto[]>('/api/admin/users'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (hasCap('admin')) void load();
  }, [hasCap, load]);

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  if (!hasCap('admin')) return <p className="text-sm text-slate-500">无权访问。</p>;

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (form.password !== form.confirmPassword) {
      setFormError('两次输入的密码不一致');
      return;
    }
    if (form.roles.length === 0) {
      setFormError('至少选择一个角色');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/admin/users', {
        body: { username: form.username, password: form.password, roles: form.roles },
      });
      closeModal();
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(row: UserDto) {
    const status = row.status === 'active' ? 'disabled' : 'active';
    try {
      await api.put(`/api/admin/users/${row.id}`, { body: { status } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetPassword(row: UserDto) {
    const next = window.prompt(`为「${row.username}」设置新密码（至少 8 位）：`);
    if (!next) return;
    try {
      await api.post(`/api/admin/users/${row.id}/reset-password`, { body: { password: next } });
      setError(null);
      window.alert('密码已重置');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: UserDto) {
    if (!window.confirm(`确认删除用户「${row.username}」？`)) return;
    try {
      await api.del(`/api/admin/users/${row.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">用户管理</h1>
        <button className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={openCreate}>
          创建用户
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">用户名</th>
            <th className="p-2">角色</th>
            <th className="p-2">状态</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{row.username}</td>
              <td className="p-2">{row.roles.map((r) => ROLE_LABELS[r]).join('、')}</td>
              <td className="p-2">{row.status === 'active' ? '正常' : '已禁用'}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600 underline" onClick={() => void toggleStatus(row)}>
                  {row.status === 'active' ? '禁用' : '启用'}
                </button>
                <button className="text-blue-600 underline" onClick={() => void resetPassword(row)}>重置密码</button>
                <button className="text-red-600 underline" onClick={() => void remove(row)}>删除</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={4}>暂无用户。</td>
            </tr>
          )}
        </tbody>
      </table>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeModal}>
          <form
            onSubmit={create}
            className="w-full max-w-md space-y-3 rounded bg-white p-4 text-sm shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-medium">创建用户</h2>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <label className="block">
              用户名
              <input
                className="mt-1 w-full rounded border px-2 py-1"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
              />
            </label>
            <label className="block">
              初始密码
              <input
                type="password"
                className="mt-1 w-full rounded border px-2 py-1"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            </label>
            <label className="block">
              确认密码
              <input
                type="password"
                className="mt-1 w-full rounded border px-2 py-1"
                value={form.confirmPassword}
                onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                required
              />
            </label>
            <div className="block">
              角色
              <div className="mt-1 flex flex-wrap gap-3">
                {ROLES.map((r) => (
                  <label key={r} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={form.roles.includes(r)}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          roles: e.target.checked ? [...f.roles, r] : f.roles.filter((x) => x !== r),
                        }))
                      }
                    />
                    {ROLE_LABELS[r]}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="rounded border px-4 py-1.5" onClick={closeModal}>
                取消
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
              >
                {busy ? '创建中…' : '创建用户'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
