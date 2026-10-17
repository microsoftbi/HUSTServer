import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pencil, Plug } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Field, Input } from '../components/ui/input.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
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
      window.alert('保存成功');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const editingNode = nodes.find((node) => node.node_id === editId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="数据连接"
        description="仅可配置该工作流内的 SQL Server 输入/输出节点连接；未修改的节点默认使用工作流文件中的配置。"
      >
        <Button asChild variant="outline">
          <Link to="/workflows">返回工作流列表</Link>
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>
      )}

      <Card className="overflow-hidden">
        {nodes.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="无可配置节点"
            description="该工作流没有可配置的 SQL Server 节点。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>节点</TableHead>
                <TableHead className="w-48">类型</TableHead>
                <TableHead className="w-40">当前来源</TableHead>
                <TableHead className="w-32 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((node) => (
                <TableRow key={node.node_id}>
                  <TableCell className="font-medium">{node.name ?? node.node_id}</TableCell>
                  <TableCell className="text-muted-foreground">{node.kind}</TableCell>
                  <TableCell>
                    <Badge tone={node.config ? 'primary' : 'neutral'}>
                      {node.config ? '工作流内配置' : '沿用工作流文件'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(node)}>
                        <Pencil />
                        编辑
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {editId && (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="mb-3 text-sm font-medium">
            编辑节点连接：{editingNode?.name ?? editId}
          </p>
          <form onSubmit={submit} className="space-y-3">
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
              <Field label="密码" hint="留空表示沿用原值">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </Field>
              <Field label="数据库">
                <Input
                  value={form.database}
                  onChange={(e) => setForm({ ...form, database: e.target.value })}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => void test()}>
                测试连接
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditId(null);
                  setForm(EMPTY);
                }}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                保存修改
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
