import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, ListTree, Pencil, Play } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import type { RunSummary, WorkflowDetail } from '../types.js';

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过',
};

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  queued: 'neutral',
  running: 'primary',
  success: 'success',
  error: 'danger',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'neutral',
};

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  schedule: '调度',
  job: 'Job',
};

export function WorkflowDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([
        api.get<WorkflowDetail>(`/api/workflows/${id}`),
        api.get<{ items: RunSummary[] }>(`/api/workflows/${id}/runs?limit=20`),
      ]);
      setDetail(d);
      setRuns(r.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setBusy(true);
    try {
      const res = await api.post<{ runId: string }>(`/api/workflows/${id}/runs`);
      navigate(`/runs/${res.runId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) return <ErrorNote>{error}</ErrorNote>;
  if (!detail) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="space-y-4">
      <PageHeader title={detail.name} description={`工作流 ID：${id}`}>
        <Button asChild variant="outline">
          <Link to="/workflows">
            <ArrowLeft />
            返回列表
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={`/workflows/${id}/designer`}>
            <Pencil />
            编辑画布
          </Link>
        </Button>
        <Button disabled={busy} onClick={() => void runNow()}>
          <Play />
          {busy ? '提交中…' : '立即运行'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>运行历史</CardTitle>
            <CardDescription>最近 20 次运行；点击「查看日志」进入节点级详情。</CardDescription>
          </div>
          <ListTree className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        {runs.length === 0 ? (
          <EmptyState icon={Eye} title="暂无运行记录" description="点击右上角「立即运行」手动触发一次。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>时间</TableHead>
                <TableHead className="w-28">触发</TableHead>
                <TableHead className="w-32">状态</TableHead>
                <TableHead className="w-28">耗时</TableHead>
                <TableHead className="w-28 text-right">详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(run.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{TRIGGER_LABEL[run.trigger_type] ?? run.trigger_type}</TableCell>
                  <TableCell>
                    <Badge dot tone={STATUS_TONE[run.status] ?? 'neutral'}>
                      {STATUS_LABEL[run.status] ?? run.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {run.duration_ms != null ? `${run.duration_ms} ms` : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/runs/${run.id}`}>查看日志</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
