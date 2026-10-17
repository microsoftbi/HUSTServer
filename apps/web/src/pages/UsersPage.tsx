import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { History, KeyRound, Power, Trash2, Users } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { ROLE_LABELS, ROLES, type Role } from '../roles.js';
import { LoginLogsModal } from '../components/users/LoginLogsModal.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Checkbox, Field, Input } from '../components/ui/input.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Modal } from '../components/ui/modal.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';

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
  const [logUser, setLogUser] = useState<UserDto | null>(null);

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

  if (!hasCap('admin')) return <p className="text-sm text-muted-foreground">无权访问。</p>;

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
    <div className="space-y-4">
      <PageHeader title="用户管理" description="创建账号、分配角色并维护启用状态。">
        <Button onClick={openCreate}>新建用户</Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={Users} title="暂无用户" description="点击右上角「新建用户」创建第一个账号。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>用户名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-80 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.username}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.roles.map((r) => (
                        <Badge key={r} tone="neutral">
                          {ROLE_LABELS[r]}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.status === 'active' ? (
                      <Badge dot tone="success">
                        正常
                      </Badge>
                    ) : (
                      <Badge dot tone="neutral">
                        已禁用
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setLogUser(row)}>
                        <History />
                        查看登录日志
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void toggleStatus(row)}>
                        <Power />
                        {row.status === 'active' ? '禁用' : '启用'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void resetPassword(row)}>
                        <KeyRound />
                        重置密码
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => void remove(row)}
                      >
                        <Trash2 />
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="创建用户"
        footer={
          <>
            <Button type="button" variant="outline" onClick={closeModal}>
              取消
            </Button>
            <Button type="submit" form="create-user-form" disabled={busy}>
              {busy ? '创建中…' : '创建用户'}
            </Button>
          </>
        }
      >
        <form id="create-user-form" className="space-y-3" onSubmit={create}>
          {formError && <ErrorNote>{formError}</ErrorNote>}
          <Field label="用户名">
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
            />
          </Field>
          <Field label="初始密码">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </Field>
          <Field label="确认密码">
            <Input
              type="password"
              value={form.confirmPassword}
              onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
              required
            />
          </Field>
          <Field label="角色">
            <div className="flex flex-wrap gap-3">
              {ROLES.map((r) => (
                <label key={r} className="flex items-center gap-1.5">
                  <Checkbox
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
          </Field>
        </form>
      </Modal>

      <LoginLogsModal open={logUser !== null} user={logUser} onClose={() => setLogUser(null)} />
    </div>
  );
}
