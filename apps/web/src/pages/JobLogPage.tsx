import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { RUN_STATUS_TONE, describeSchedule } from '../jobDisplay.js';
import type { JobSummary } from '../types.js';

const TRIGGER_LABEL: Record<'manual' | 'schedule', string> = {
  manual: '手动',
  schedule: '定时',
};

/** 按最近运行时间倒序；从未运行的排最后，同序按名称升序 */
function byRecentRun(a: JobSummary, b: JobSummary): number {
  const at = a.lastRun?.created_at ?? -1;
  const bt = b.lastRun?.created_at ?? -1;
  if (at !== bt) return bt - at;
  return a.name.localeCompare(b.name);
}

export function JobLogPage() {
  const [items, setItems] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: JobSummary[] }>('/api/jobs');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = [...items].sort(byRecentRun);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Job 日志"
        description="各 Job 的最近一次运行状态、触发方式与耗时；调度配置为「未启用」表示定时未开启。"
      >
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw />
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title={loading ? '加载中…' : '暂无 Job'}
            description={loading ? undefined : '在 Job 编排页创建并运行后，这里会显示运行日志。'}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Job 名称</TableHead>
                  <TableHead className="w-56">调度配置</TableHead>
                  <TableHead className="w-48">运行时间</TableHead>
                  <TableHead className="w-28">运行结果</TableHead>
                  <TableHead className="w-24">触发方式</TableHead>
                  <TableHead className="w-24 text-right">耗时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Link className="font-medium hover:text-primary hover:underline" to={`/jobs/${job.id}`}>
                        {job.name}
                      </Link>
                      {job.description && (
                        <div className="text-xs text-muted-foreground">{job.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{describeSchedule(job)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.lastRun ? new Date(job.lastRun.created_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell>
                      {job.lastRun ? (
                        <Link to={`/job-runs/${job.lastRun.id}`}>
                          <Badge dot tone={RUN_STATUS_TONE[job.lastRun.status] ?? 'neutral'}>
                            {job.lastRun.status}
                          </Badge>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">未运行</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.lastRun ? (TRIGGER_LABEL[job.lastRun.trigger_type] ?? job.lastRun.trigger_type) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {job.lastRun?.duration_ms != null ? `${job.lastRun.duration_ms} ms` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="px-4 py-2 text-xs text-muted-foreground">共 {rows.length} 个 Job</p>
          </>
        )}
      </Card>
    </div>
  );
}
