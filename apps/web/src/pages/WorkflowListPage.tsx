import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, Workflow } from 'lucide-react';
import { api } from '../api.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import type { WorkflowSummary } from '../types.js';

export function WorkflowListPage() {
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.get<WorkflowSummary[]>('/api/workflows'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string, name: string) {
    if (!window.confirm(`确定删除工作流「${name}」？其运行记录将一并删除。`)) return;
    await api.del(`/api/workflows/${id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="工作流" description="托管 HUSTERYX 工作流，或直接在浏览器里拖拽搭建。">
        <Button asChild variant="outline">
          <Link to="/workflows/new">上传工作流</Link>
        </Button>
        <Button asChild>
          <Link to="/workflows/new/designer">新建画布</Link>
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={Workflow}
            title="暂无工作流"
            description="点击右上角「上传工作流」导入 .htyx 文件，或「新建画布」从零搭建。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead className="w-64">更新时间</TableHead>
                <TableHead className="w-56 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>
                    <Link className="font-medium hover:text-primary hover:underline" to={`/workflows/${w.id}`}>
                      {w.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(w.updated_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/workflows/${w.id}/designer`}>
                          <Pencil />
                          编辑画布
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => void remove(w.id, w.name)}
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

      {items.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">共 {items.length} 个工作流</p>
      )}
    </div>
  );
}
