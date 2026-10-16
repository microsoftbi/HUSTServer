import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { JobRunSummary, JobStepRunSummary } from '../types.js';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  skipped: '已跳过',
  pending: '等待中',
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
        <Link className="text-blue-600 underline" to={`/runs/${parsed.runId}`}>
          查看运行详情
        </Link>
      );
    }
    if (typeof parsed.rowsAffected === 'number') {
      return <span className="text-slate-500">影响 {parsed.rowsAffected} 行</span>;
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

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!jobRun) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Job 运行详情</h1>
        <Link className="text-sm text-blue-600 underline" to={`/jobs/${jobRun.job_id}`}>返回 Job</Link>
      </div>
      <div className="rounded border bg-white p-4 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            状态：
            <span className={jobRun.status === 'error' ? 'text-red-600' : 'font-medium'}>
              {STATUS_LABEL[jobRun.status] ?? jobRun.status}
            </span>
          </span>
          <span>触发方式：{jobRun.trigger_type === 'manual' ? '手动' : '调度'}</span>
          <span>开始时间：{jobRun.started_at ? new Date(jobRun.started_at).toLocaleString() : '—'}</span>
          <span>耗时：{jobRun.duration_ms != null ? `${jobRun.duration_ms} ms` : '—'}</span>
        </div>
        {jobRun.error && <p className="mt-2 text-red-600">{jobRun.error}</p>}
      </div>
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">顺序</th>
            <th className="p-2">步骤</th>
            <th className="p-2">类型</th>
            <th className="p-2">状态</th>
            <th className="p-2">耗时</th>
            <th className="p-2">结果</th>
            <th className="p-2">错误</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.id} className="border-t">
              <td className="p-2">{s.seq + 1}</td>
              <td className="p-2">{s.name}</td>
              <td className="p-2">{s.type === 'workflow' ? '工作流' : s.type === 'sql' ? 'SQL' : '加载成模型'}</td>
              <td className={`p-2 ${s.status === 'error' ? 'text-red-600' : s.status === 'skipped' ? 'text-slate-400' : ''}`}>
                {STATUS_LABEL[s.status] ?? s.status}
              </td>
              <td className="p-2">{s.duration_ms != null ? `${s.duration_ms} ms` : '—'}</td>
              <td className="p-2"><StepOutput step={s} /></td>
              <td className="p-2 text-red-600">{s.error}</td>
            </tr>
          ))}
          {steps.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={7}>暂无步骤记录。</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
