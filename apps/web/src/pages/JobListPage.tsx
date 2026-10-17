import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ListChecks, Pencil, Play, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import type { JobSummary } from '../types.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

/** 最近运行状态的徽标色调映射 */
const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  queued: 'neutral',
  running: 'primary',
  success: 'success',
  error: 'danger',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'neutral',
};

/** 把 5 段 cron 翻译成人话；复杂表达式原样展示。 */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom !== '*' && dow !== '*') return expr;
  if (dom !== '*') return `每月 ${dom} 日 ${time}`;
  if (dow === '*') return `每天 ${time}`;
  const days = dow.split(',').map((d) => WEEKDAYS[Number(d)] ?? d);
  return `每${days.join('、')} ${time}`;
}

function describeSchedule(job: JobSummary): string {
  if (!job.enabled || !job.cron_expr) return '未启用';
  return `${describeCron(job.cron_expr)}（${job.timezone}）`;
}

export function JobListPage() {
  const [items, setItems] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function load() {
    try {
      const res = await api.get<{ items: JobSummary[] }>('/api/jobs');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(job: JobSummary) {
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${job.id}/runs`);
      navigate(`/job-runs/${res.jobRunId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(job: JobSummary) {
    if (!window.confirm(`确定删除 Job「${job.name}」？其运行历史将一并删除。`)) return;
    await api.del(`/api/jobs/${job.id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Job 编排" description="把工作流、SQL 与加载模型串成可定时运行的流水线。">
        <Button asChild>
          <Link to="/jobs/new">新建 Job</Link>
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="暂无 Job"
            description="点击右上角「新建 Job」，把工作流、SQL 与加载模型串成流水线。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead className="w-24">步骤数</TableHead>
                <TableHead className="w-64">调度</TableHead>
                <TableHead className="w-28">最近运行</TableHead>
                <TableHead className="w-48">更新时间</TableHead>
                <TableHead className="w-40 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Link className="font-medium hover:text-primary hover:underline" to={`/jobs/${job.id}`}>
                      {job.name}
                    </Link>
                    {job.description && <div className="text-xs text-muted-foreground">{job.description}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{job.stepCount}</TableCell>
                  <TableCell className="text-muted-foreground">{describeSchedule(job)}</TableCell>
                  <TableCell>
                    {job.lastRun ? (
                      <Link to={`/job-runs/${job.lastRun.id}`}>
                        <Badge dot tone={RUN_STATUS_TONE[job.lastRun.status] ?? 'neutral'}>
                          {job.lastRun.status}
                        </Badge>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">从未运行</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(job.updated_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void run(job)}>
                        <Play />
                        运行
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/jobs/${job.id}`}>
                          <Pencil />
                          编辑
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => void remove(job)}
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

      {items.length > 0 && <p className="px-1 text-xs text-muted-foreground">共 {items.length} 个 Job</p>}
    </div>
  );
}
