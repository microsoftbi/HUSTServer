import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';

interface UserDto {
  id: string;
  username: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

export function UsersPage() {
  const { hasCap } = useAuth();
  const [rows, setRows] = useState<UserDto[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  if (!hasCap('admin')) return <p className="text-sm text-slate-500">无权访问。</p>;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/users', { body: { username, password, role } });
      setUsername('');
      setPassword('');
      setRole('user');
      await load();
    } catch (err) {
      setError((err as Error).message);
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
      <h1 className="text-xl font-semibold">用户管理</h1>
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
              <td className="p-2">{row.role === 'admin' ? '管理员' : '普通用户'}</td>
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

      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded border p-4 text-sm">
        <label className="block">
          用户名
          <input
            className="mt-1 block rounded border px-2 py-1"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="block">
          初始密码
          <input
            type="password"
            className="mt-1 block rounded border px-2 py-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="block">
          角色
          <select
            className="mt-1 block rounded border px-2 py-1"
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? '创建中…' : '创建用户'}
        </button>
      </form>
    </div>
  );
}
