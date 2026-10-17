import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Pencil, PenLine, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { EmptyState } from '../../components/ui/empty-state.js';
import { ErrorNote } from '../../components/ui/error-note.js';
import { Field, Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { uid } from './lib/utils';
import type { DashboardPayload } from './types';

interface DashboardSummary {
  id: string;
  name: string;
  owner_id: string | null;
  updated_at: number;
}

function makeInitialPayload(): DashboardPayload {
  const dash = { id: uid('dash'), name: '仪表盘 1', widgets: [] };
  return { version: 2, dashboards: [dash], activeId: dash.id, datasets: [] };
}

export function DashboardListPage() {
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
    window.alert('保存成功');
    await load();
  }

  async function remove(row: DashboardSummary) {
    if (!window.confirm(`确定删除仪表板「${row.name}」？`)) return;
    await api.del(`/api/dashboards/${row.id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="仪表板" description="拖拽字段即可生成图表；点击名称进入只读预览。">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          新建仪表板
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={LayoutDashboard}
            title="暂无仪表板"
            description="点击右上角「新建仪表板」创建第一个仪表板。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead className="w-64">更新时间</TableHead>
                <TableHead className="w-64 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      className="font-medium hover:text-primary hover:underline"
                      to={`/dashboards/${row.id}/preview`}
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(row.updated_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/dashboards/${row.id}`}>
                          <Pencil />
                          编辑
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRenameTarget(row);
                          setRenameName(row.name);
                        }}
                      >
                        <PenLine />
                        重命名
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
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建仪表板"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={!createName.trim()} onClick={() => void create()}>
              创建
            </Button>
          </>
        }
      >
        <Field label="名称">
          <Input
            placeholder="仪表板名称"
            value={createName}
            autoFocus
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
        </Field>
      </Modal>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="重命名仪表板"
        footer={
          <>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button disabled={!renameName.trim()} onClick={() => void rename()}>
              保存
            </Button>
          </>
        }
      >
        <Field label="名称">
          <Input
            value={renameName}
            autoFocus
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename();
            }}
          />
        </Field>
      </Modal>
    </div>
  );
}
