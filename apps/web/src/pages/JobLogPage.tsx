import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Modal } from '../components/ui/modal.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { STATUS_LABEL, StepDetail, TYPE_LABEL } from '../features/jobs/JobRunSteps.js';
import { RUN_STATUS_TONE } from '../jobDisplay.js';
import type { JobRunListItem, JobRunSummary, JobStepRunSummary } from '../types.js';

/** 每页条数；「加载更多」按此偏移继续拉取。 */
const PAGE_SIZE = 50;

const TRIGGER_LABEL: Record<'manual' | 'schedule', string> = {
  manual: '手动',
  schedule: '定时',
};

/** 运行记录详情弹窗：概览 + 步骤明细（含工作流子运行日志）。 */
function RunDetailDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ run: JobRunSummary; steps: JobStepRunSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .get<{ jobRun: JobRunSummary; steps: JobStepRunSummary[] }>(`/api/job-runs/${runId}`)
      .then((res) => {
        if (!cancelled) setData({ run: res.jobRun, steps: res.steps });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const run = data?.run ?? null;
  const steps = data?.steps ?? [];

  return (
    <Modal
      open={runId !== null}
      onClose={onClose}
      title="运行详情"
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {runId && (
            <Button asChild>
              <Link to={`/job-runs/${runId}`}>完整页面</Link>
            </Button>
          )}
        </>
      }
    >
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !run ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <Badge dot tone={RUN_STATUS_TONE[run.status] ?? 'neutral'}>
              {STATUS_LABEL[run.status] ?? run.status}
            </Badge>
            <span>触发方式：{TRIGGER_LABEL[run.trigger_type] ?? run.trigger_type}</span>
            <span>开始：{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</span>
            <span>结束：{run.finished_at ? new Date(run.finished_at).toLocaleString() : '—'}</span>
            <span>耗时：{run.duration_ms != null ? `${run.duration_ms} ms` : '—'}</span>
          </div>

          {run.error && <ErrorNote>{run.error}</ErrorNote>}

          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border">
            {steps.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground">该次运行暂无步骤记录。</div>
            ) : (
              steps.map((step) => (
                <div key={step.id} className="border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-muted-foreground">{step.seq + 1}</span>
                    <Badge dot tone={RUN_STATUS_TONE[step.status] ?? 'neutral'} className="shrink-0">
                      {STATUS_LABEL[step.status] ?? step.status}
                    </Badge>
                    <span className="min-w-0 truncate font-medium" title={step.name}>
                      {step.name}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{TYPE_LABEL[step.type] ?? step.type}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {step.duration_ms != null ? `${step.duration_ms} ms` : '—'}
                    </span>
                  </div>
                  <div className="mt-1 space-y-1 pl-7">
                    <StepDetail step={step} live={step.status === 'running'} />
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

export function JobLogPage() {
  const [items, setItems] = useState<JobRunListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const res = await api.get<{ total: number; items: JobRunListItem[] }>(
        `/api/job-runs?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Job 日志"
        description="所有 Job 的运行记录，按运行时间倒序；点击「详细」可查看该次运行的步骤与日志。"
      >
        <Button variant="outline" disabled={loading} onClick={() => void load(0)}>
          <RefreshCw />
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title={loading ? '加载中…' : '暂无运行记录'}
            description={loading ? undefined : '在 Job 编排页运行 Job 后，这里会显示每次运行的记录。'}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-48">运行时间</TableHead>
                  <TableHead>Job 名称</TableHead>
                  <TableHead className="w-24">触发方式</TableHead>
                  <TableHead className="w-28">运行结果</TableHead>
                  <TableHead className="w-24 text-right">耗时</TableHead>
                  <TableHead className="w-64">错误</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="text-muted-foreground">
                      {run.started_at
                        ? new Date(run.started_at).toLocaleString()
                        : new Date(run.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">{run.job_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {TRIGGER_LABEL[run.trigger_type] ?? run.trigger_type}
                    </TableCell>
                    <TableCell>
                      <Link to={`/job-runs/${run.id}`}>
                        <Badge dot tone={RUN_STATUS_TONE[run.status] ?? 'neutral'}>
                          {STATUS_LABEL[run.status] ?? run.status}
                        </Badge>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {run.duration_ms != null ? `${run.duration_ms} ms` : '—'}
                    </TableCell>
                    <TableCell className="text-destructive">{run.error ?? ''}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setDetailRunId(run.id)}>
                        详细
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
              <span>
                共 {total} 条运行记录，已显示 {items.length} 条
              </span>
              {items.length < total && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={loading}
                  onClick={() => void load(items.length)}
                >
                  {loading ? '加载中…' : '加载更多'}
                </Button>
              )}
            </div>
          </>
        )}
      </Card>

      <RunDetailDialog runId={detailRunId} onClose={() => setDetailRunId(null)} />
    </div>
  );
}
