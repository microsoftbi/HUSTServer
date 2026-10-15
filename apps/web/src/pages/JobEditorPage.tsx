import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { JobOnFailure, JobRunSummary, JobStepType, WorkflowSummary } from '../types.js';

interface ConnectionOption {
  id: string;
  name: string;
  type: string;
}

/** 编辑器内的步骤草稿（key 仅用于 React 列表渲染）。 */
interface EditorStep {
  key: number;
  type: JobStepType;
  name: string;
  workflowId: string;
  connectionId: string;
  sql: string;
  onFailure: JobOnFailure;
}

interface ScheduleForm {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron';
  time: string;
  weekday: number;
  monthDay: number;
  cronExpr: string;
  timezone: string;
}

interface JobDetailLike {
  id: string;
  name: string;
  description: string | null;
  steps: Array<{
    type: JobStepType;
    name: string;
    config: { workflowId?: string; connectionId?: string; sql?: string };
    onFailure: JobOnFailure;
  }>;
  schedule: {
    enabled: boolean;
    freqType: 'daily' | 'weekly' | 'monthly' | 'cron' | null;
    cronExpr: string | null;
    timezone: string;
  };
}

const DEFAULT_SCHEDULE: ScheduleForm = {
  enabled: false,
  freqType: 'daily',
  time: '08:00',
  weekday: 1,
  monthDay: 1,
  cronExpr: '0 8 * * *',
  timezone: 'Asia/Shanghai',
};

const FREQ_OPTIONS: Array<{ value: ScheduleForm['freqType']; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'cron', label: '自定义 cron' },
];

let stepKeySeed = 0;
function nextStepKey(): number {
  stepKeySeed += 1;
  return stepKeySeed;
}

function newStep(type: JobStepType): EditorStep {
  return {
    key: nextStepKey(),
    type,
    name: type === 'workflow' ? '运行工作流' : '运行 SQL',
    workflowId: '',
    connectionId: '',
    sql: '',
    onFailure: 'abort',
  };
}

/** 把 DB 里的调度字段反解回表单；解析不出预设时回退为 cron 模式。 */
function cronToForm(freqType: string | null, cronExpr: string | null, timezone: string, enabled: boolean): ScheduleForm {
  const base: ScheduleForm = { ...DEFAULT_SCHEDULE, timezone, enabled };
  if (!freqType || !cronExpr) return base;
  if (freqType === 'cron') return { ...base, freqType: 'cron', cronExpr };
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, freqType: 'cron', cronExpr };
  const [min, hour] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (freqType === 'daily') return { ...base, freqType: 'daily', time };
  if (freqType === 'weekly') {
    const dow = Number(parts[4]);
    return { ...base, freqType: 'weekly', time, weekday: Number.isInteger(dow) ? dow : 1 };
  }
  const dom = Number(parts[2]);
  return { ...base, freqType: 'monthly', time, monthDay: Number.isInteger(dom) ? dom : 1 };
}

export function JobEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<EditorStep[]>([newStep('workflow')]);
  const [schedule, setSchedule] = useState<ScheduleForm>(DEFAULT_SCHEDULE);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [history, setHistory] = useState<JobRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.get<WorkflowSummary[]>('/api/workflows').then(setWorkflows).catch(() => {});
    void api
      .get<ConnectionOption[]>('/api/connections')
      .then((list) => setConnections(list.filter((c) => c.type === 'sqlserver')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) return;
    void (async () => {
      try {
        const job = await api.get<JobDetailLike>(`/api/jobs/${id}`);
        setName(job.name);
        setDescription(job.description ?? '');
        setSteps(job.steps.map((s) => ({
          key: nextStepKey(),
          type: s.type,
          name: s.name,
          workflowId: s.config.workflowId ?? '',
          connectionId: s.config.connectionId ?? '',
          sql: s.config.sql ?? '',
          onFailure: s.onFailure,
        })));
        setSchedule(cronToForm(job.schedule.freqType, job.schedule.cronExpr, job.schedule.timezone, job.schedule.enabled));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [id, isNew]);

  useEffect(() => {
    if (isNew) return;
    void api
      .get<{ items: JobRunSummary[] }>(`/api/jobs/${id}/runs?limit=10`)
      .then((res) => setHistory(res.items))
      .catch(() => {});
  }, [id, isNew]);

  const updateStep = (key: number, patch: Partial<EditorStep>): void => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const moveStep = (index: number, dir: -1 | 1): void => {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  function validate(): string | null {
    if (!name.trim()) return '请填写 Job 名称';
    if (steps.length === 0) return '至少需要一个步骤';
    for (const [i, s] of steps.entries()) {
      if (s.type === 'workflow' && !s.workflowId) return `步骤 ${i + 1}：请选择工作流`;
      if (s.type === 'sql') {
        if (!s.connectionId) return `步骤 ${i + 1}：请选择连接`;
        if (!s.sql.trim()) return `步骤 ${i + 1}：请填写 SQL`;
      }
    }
    if (schedule.enabled && schedule.freqType === 'cron' && !schedule.cronExpr.trim()) return '请填写 cron 表达式';
    return null;
  }

  async function save(): Promise<void> {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        steps: steps.map((s) =>
          s.type === 'workflow'
            ? { type: s.type, name: s.name, workflowId: s.workflowId, onFailure: s.onFailure }
            : { type: s.type, name: s.name, connectionId: s.connectionId, sql: s.sql, onFailure: s.onFailure },
        ),
        schedule: schedule.enabled
          ? {
              enabled: true,
              freqType: schedule.freqType,
              time: schedule.time,
              weekday: schedule.weekday,
              monthDay: schedule.monthDay,
              cronExpr: schedule.cronExpr,
              timezone: schedule.timezone,
            }
          : { enabled: false },
      };
      if (isNew) {
        const created = await api.post<{ id: string }>('/api/jobs', { body });
        navigate(`/jobs/${created.id}`, { replace: true });
      } else {
        await api.put(`/api/jobs/${id}`, { body });
        setError(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow(): Promise<void> {
    if (!id) return;
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${id}/runs`);
      navigate(`/job-runs/${res.jobRunId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const inputClass = 'w-full rounded border px-2 py-1.5 text-sm';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{isNew ? '新建 Job' : '编辑 Job'}</h1>
        <Link className="text-sm text-blue-600 underline" to="/jobs">返回列表</Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2 rounded border bg-white p-4">
        <h2 className="font-medium">基本信息</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm">
            名称（必填）
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-sm">
            描述
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded border bg-white p-4">
        <h2 className="font-medium">步骤编排</h2>
        {steps.map((s, i) => (
          <div key={s.key} className="space-y-2 rounded border p-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{i + 1}.</span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{s.type === 'workflow' ? '工作流' : 'SQL'}</span>
              <input
                className={`${inputClass} max-w-48`}
                value={s.name}
                onChange={(e) => updateStep(s.key, { name: e.target.value })}
              />
              <div className="ml-auto flex gap-1">
                <button className="rounded border px-2" disabled={i === 0} onClick={() => moveStep(i, -1)}>上移</button>
                <button className="rounded border px-2" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}>下移</button>
                <button className="rounded border px-2 text-red-600" onClick={() => setSteps((prev) => prev.filter((x) => x.key !== s.key))}>删除</button>
              </div>
            </div>
            <label className="block text-sm">
              失败策略
              <select
                className={inputClass}
                value={s.onFailure}
                onChange={(e) => updateStep(s.key, { onFailure: e.target.value as JobOnFailure })}
              >
                <option value="abort">中止（后续步骤跳过）</option>
                <option value="continue">继续（记录失败并执行下一步）</option>
              </select>
            </label>
            {s.type === 'workflow' ? (
              <label className="block text-sm">
                工作流
                <select className={inputClass} value={s.workflowId} onChange={(e) => updateStep(s.key, { workflowId: e.target.value })}>
                  <option value="">请选择…</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="block text-sm">
                  连接（SQL Server）
                  <select className={inputClass} value={s.connectionId} onChange={(e) => updateStep(s.key, { connectionId: e.target.value })}>
                    <option value="">请选择…</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  SQL（将直接在该连接上执行）
                  <textarea className={`${inputClass} h-24 font-mono`} value={s.sql} onChange={(e) => updateStep(s.key, { sql: e.target.value })} />
                </label>
              </>
            )}
          </div>
        ))}
        <select
          className={inputClass}
          value=""
          onChange={(e) => {
            if (e.target.value) setSteps((prev) => [...prev, newStep(e.target.value as JobStepType)]);
            e.target.value = '';
          }}
        >
          <option value="">+ 添加步骤…</option>
          <option value="workflow">运行工作流</option>
          <option value="sql">运行 SQL</option>
        </select>
      </section>

      <section className="space-y-2 rounded border bg-white p-4">
        <h2 className="font-medium">调度配置</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={schedule.enabled} onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })} />
          启用定时调度
        </label>
        {schedule.enabled && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              频次
              <select
                className={inputClass}
                value={schedule.freqType}
                onChange={(e) => setSchedule({ ...schedule, freqType: e.target.value as ScheduleForm['freqType'] })}
              >
                {FREQ_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {schedule.freqType !== 'cron' && (
              <label className="text-sm">
                时间
                <input type="time" className={inputClass} value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
              </label>
            )}
            {schedule.freqType === 'weekly' && (
              <label className="text-sm">
                星期
                <select className={inputClass} value={schedule.weekday} onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}>
                  {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, idx) => (
                    <option key={idx} value={idx}>{label}</option>
                  ))}
                </select>
              </label>
            )}
            {schedule.freqType === 'monthly' && (
              <label className="text-sm">
                日期（1-31）
                <input type="number" min={1} max={31} className={inputClass} value={schedule.monthDay} onChange={(e) => setSchedule({ ...schedule, monthDay: Number(e.target.value) })} />
              </label>
            )}
            {schedule.freqType === 'cron' && (
              <label className="text-sm">
                cron 表达式（5 段）
                <input className={`${inputClass} font-mono`} value={schedule.cronExpr} onChange={(e) => setSchedule({ ...schedule, cronExpr: e.target.value })} />
              </label>
            )}
            <label className="text-sm">
              时区
              <input className={inputClass} value={schedule.timezone} onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })} />
            </label>
          </div>
        )}
      </section>

      <div className="flex items-center gap-2">
        <button className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        {!isNew && (
          <button className="rounded border px-4 py-1.5" onClick={() => void runNow()}>手动运行</button>
        )}
      </div>

      {!isNew && (
        <section className="space-y-2 rounded border bg-white p-4">
          <h2 className="font-medium">最近运行（10 条）</h2>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">暂无运行记录。</p>
          ) : (
            <table className="w-full border text-left text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-2">状态</th>
                  <th className="p-2">触发方式</th>
                  <th className="p-2">开始时间</th>
                  <th className="p-2">耗时</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className={`p-2 ${r.status === 'error' ? 'text-red-600' : ''}`}>
                      <Link className="underline" to={`/job-runs/${r.id}`}>{r.status}</Link>
                    </td>
                    <td className="p-2">{r.trigger_type === 'manual' ? '手动' : '调度'}</td>
                    <td className="p-2">{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                    <td className="p-2">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
