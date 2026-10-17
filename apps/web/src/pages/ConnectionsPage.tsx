import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plug, PlugZap, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Checkbox, Field, Input, Select } from '../components/ui/input.js';
import { Modal } from '../components/ui/modal.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';

interface ConnectionDto {
  id: string;
  name: string;
  type: string;
  shared: boolean;
  owner_id: string | null;
  updated_at: number;
  config: Record<string, unknown>;
  /** 服务端解密失败（通常是 ENCRYPTION_KEY 已变更），此时 config 为空对象。 */
  configError?: boolean;
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

/** 服务器列的展示文本：server:port/database。 */
function serverText(row: ConnectionDto): string {
  const server = String(row.config.server ?? '');
  const port = String(row.config.port ?? '');
  const database = String(row.config.database ?? '');
  const host = port ? `${server}:${port}` : server;
  return database ? `${host}/${database}` : host;
}

export function ConnectionsPage() {
  const { hasCap } = useAuth();
  const canManage = hasCap('connection.manage');
  const [rows, setRows] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState<ConnectionForm>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbTested, setDbTested] = useState(false);
  const [msgBox, setMsgBox] = useState<{ ok: boolean; msg: string } | null>(null);

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
      closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

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
        window.alert('保存成功');
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

  const brokenCount = rows.filter((row) => row.configError).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="数据连接"
        description="平台级共享连接库，密码在服务端加密存储，界面仅显示掩码。"
      >
        <Button onClick={openCreate}>新建连接</Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}
      {brokenCount > 0 && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          有 {brokenCount} 个连接无法解密，请确认服务器的 ENCRYPTION_KEY 未变更；可编辑该连接并重新保存，以用当前密钥重新加密。
        </p>
      )}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="暂无连接"
            description="点击右上角「新建连接」添加一个 SQL Server 连接。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead className="w-32">类型</TableHead>
                <TableHead>服务器</TableHead>
                <TableHead className="w-24">共享</TableHead>
                <TableHead className="w-56">更新时间</TableHead>
                <TableHead className="w-56 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="font-medium">{row.name}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.type}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.configError ? (
                      <span className="text-destructive">（无法解密）</span>
                    ) : (
                      serverText(row) || '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={row.shared ? 'primary' : 'neutral'}>{row.shared ? '共享' : '不共享'}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(row.updated_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void test(row)}>
                        <PlugZap />
                        测试
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                        <Pencil />
                        编辑
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
        title={editId ? '编辑连接' : '新建连接'}
        className="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" onClick={closeModal}>
              取消
            </Button>
            <Button type="submit" form="connection-form" disabled={busy}>
              {editId ? '保存修改' : '创建'}
            </Button>
          </>
        }
      >
        <form id="connection-form" onSubmit={submit} className="space-y-3">
          {formError && <ErrorNote>{formError}</ErrorNote>}
          <Field label="名称">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="服务器">
              <Input
                value={form.server}
                onChange={(e) => setForm({ ...form, server: e.target.value })}
                required
              />
            </Field>
            <Field label="端口">
              <Input
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
              />
            </Field>
            <Field label="用户">
              <Input
                value={form.user}
                onChange={(e) => setForm({ ...form, user: e.target.value })}
              />
            </Field>
            <Field label="密码" hint={editId ? '留空表示沿用原值' : undefined}>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => void testDraft()} disabled={testing || busy}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            {testResult && <Badge tone={testResult.ok ? 'success' : 'danger'}>{testResult.msg}</Badge>}
          </div>
          <Field label="数据库">
            <Select
              value={form.database}
              onChange={(e) => setForm({ ...form, database: e.target.value })}
              disabled={!dbTested}
            >
              {dbTested ? (
                databases.map((db) => (
                  <option key={db} value={db}>
                    {db}
                  </option>
                ))
              ) : (
                <option value={form.database}>{form.database || '请先测试连接'}</option>
              )}
            </Select>
          </Field>
          {canManage && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.shared}
                onChange={(e) => setForm({ ...form, shared: e.target.checked })}
              />
              共享给所有用户
            </label>
          )}
        </form>
      </Modal>

      <Modal
        open={msgBox !== null}
        onClose={() => setMsgBox(null)}
        title="测试连接"
        className="max-w-sm"
        footer={
          <Button onClick={() => setMsgBox(null)}>确定</Button>
        }
      >
        <p className={msgBox?.ok ? 'text-sm text-success' : 'text-sm text-destructive'}>{msgBox?.msg}</p>
      </Modal>
    </div>
  );
}
