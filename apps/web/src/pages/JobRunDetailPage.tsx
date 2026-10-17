import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ListChecks } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import type { JobRunSummary, JobStepRunSummary } from '../types.js';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  skipped: '已跳过',
  pending: '排队中',
};

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const STATUS_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  pending: 'neutral',
  running: 'primary',
  success: 'success',
  error: 'danger',
  skipped: 'neutral',
};

/** 处于这些状态需要轮询刷新；到达终态后停止。 */
const ACTIVE_STATUSES = new Set(['queued', 'running', 'pending']);
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 1000;

function StepOutput({ step }: { step: JobStepRunSummary }) {
  if (!step.output) return null;
  try {
    const parsed = JSON.parse(step.output) as { runId?: string; rowsAffected?: number; rowCount?: number };
    if (step.type === 'workflow' && parsed.runId) {
      return (
        <Link className="text-primary hover:underline" to={`/runs/${parsed.runId}`}>
          查看运行详情
        </Link>
      );
    }
    if (typeof parsed.rowsAffected === 'number') {
      return <span className="text-muted-foreground">影响 {parsed.rowsAffected} 行</span>;
    }
  } catch {
    /* 忽略非 JSON output */
  }
  return null;
}

export function JobRunDetailPage() {
  const { id = '' } = useParams();
  const [jobRun, setJobRun] = useState<JobRunSummary | null>(null);
  const [steps, setSteps] = useState<JobStepRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const detail = await api.get<{ jobRun: JobRunSummary; steps: JobStepRunSummary[] }>(`/api/job-runs/${id}`);
      setJobRun(detail.jobRun);
      setSteps(detail.steps);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!jobRun || !ACTIVE_STATUSES.has(jobRun.status)) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [jobRun, load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!jobRun) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="space-y-4">
      <PageHeader title="Job 运行详情" description={`Job ID：${jobRun.job_id}`}>
        <Button asChild variant="outline">
          <Link to={`/jobs/${jobRun.job_id}`}>
            <ArrowLeft />
            返回 Job
          </Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>运行概览</CardTitle>
          <Badge dot tone={STATUS_TONE[jobRun.status] ?? 'neutral'}>
            {STATUS_LABEL[jobRun.status] ?? jobRun.status}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>触发方式：{jobRun.trigger_type === 'manual' ? '手动' : '调度'}</span>
            <span>开始时间：{jobRun.started_at ? new Date(jobRun.started_at).toLocaleString() : '—'}</span>
            <span>耗时：{jobRun.duration_ms != null ? `${jobRun.duration_ms} ms` : '—'}</span>
          </div>
          {jobRun.error && <ErrorNote>{jobRun.error}</ErrorNote>}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>步骤明细</CardTitle>
        </CardHeader>
        {steps.length === 0 ? (
          <EmptyState icon={ListChecks} title="暂无步骤记录" description="该次运行尚未产生步骤明细。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-16">序号</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-28">类型</TableHead>
                <TableHead className="w-32">状态</TableHead>
                <TableHead className="w-24 text-right">耗时</TableHead>
                <TableHead className="w-40">输出</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-muted-foreground">{s.seq + 1}</TableCell>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.type === 'workflow' ? '工作流' : s.type === 'sql' ? 'SQL' : '加载成模型'}
                  </TableCell>
                  <TableCell>
                    <Badge dot tone={STATUS_TONE[s.status] ?? 'neutral'}>
                      {STATUS_LABEL[s.status] ?? s.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {s.duration_ms != null ? `${s.duration_ms} ms` : '—'}
                  </TableCell>
                  <TableCell>
                    <StepOutput step={s} />
                  </TableCell>
                  <TableCell className="text-destructive">{s.error}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
