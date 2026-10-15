import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { JobSummary } from '../types.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Job 编排</h1>
        <Link className="rounded bg-blue-600 px-3 py-1.5 text-white" to="/jobs/new">
          新建 Job
        </Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">步骤数</th>
            <th className="p-2">调度</th>
            <th className="p-2">最近运行</th>
            <th className="p-2">更新时间</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((job) => (
            <tr key={job.id} className="border-t">
              <td className="p-2">
                <Link className="text-blue-600 underline" to={`/jobs/${job.id}`}>{job.name}</Link>
                {job.description && <div className="text-xs text-slate-500">{job.description}</div>}
              </td>
              <td className="p-2">{job.stepCount}</td>
              <td className="p-2">{describeSchedule(job)}</td>
              <td className="p-2">
                {job.lastRun ? (
                  <Link
                    className={job.lastRun.status === 'error' ? 'text-red-600 underline' : 'text-slate-700 underline'}
                    to={`/job-runs/${job.lastRun.id}`}
                  >
                    {job.lastRun.status}
                  </Link>
                ) : (
                  <span className="text-slate-400">从未运行</span>
                )}
              </td>
              <td className="p-2">{new Date(job.updated_at).toLocaleString()}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600" onClick={() => void run(job)}>运行</button>
                <Link className="text-blue-600 underline" to={`/jobs/${job.id}`}>编辑</Link>
                <button className="text-red-600" onClick={() => void remove(job)}>删除</button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={6}>
                暂无 Job，点击右上角「新建 Job」。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
