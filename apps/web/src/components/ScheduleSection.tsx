import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';

type FreqType = 'daily' | 'weekly' | 'monthly' | 'cron';

interface ScheduleRow {
  id: string;
  workflow_id: string;
  enabled: number;
  freq_type: FreqType;
  cron_expr: string;
  timezone: string;
  created_at: number;
  updated_at: number;
  nextRunAt: number | null;
}

const FREQ_LABEL: Record<FreqType, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  cron: 'Cron 表达式',
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function ScheduleSection({ workflowId }: { workflowId: string }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [freqType, setFreqType] = useState<FreqType>('daily');
  const [time, setTime] = useState('08:00');
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  const [cronExpr, setCronExpr] = useState('0 8 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: ScheduleRow[] }>(`/api/workflows/${workflowId}/schedules`);
      setRows(res.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/workflows/${workflowId}/schedules`, {
        body: { freqType, time, weekday, monthDay, cronExpr, timezone, enabled: true },
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: ScheduleRow) {
    try {
      await api.put(`/api/schedules/${row.id}`, { body: { enabled: row.enabled !== 1 } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: ScheduleRow) {
    if (!window.confirm('确认删除该调度？')) return;
    try {
      await api.del(`/api/schedules/${row.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-medium">运行周期</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">频率</th>
            <th className="p-2">Cron</th>
            <th className="p-2">时区</th>
            <th className="p-2">下次运行</th>
            <th className="p-2">状态</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{FREQ_LABEL[row.freq_type]}</td>
              <td className="p-2 font-mono">{row.cron_expr}</td>
              <td className="p-2">{row.timezone}</td>
              <td className="p-2">{row.nextRunAt ? new Date(row.nextRunAt).toLocaleString() : '-'}</td>
              <td className="p-2">{row.enabled === 1 ? '启用' : '停用'}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600 underline" onClick={() => void toggle(row)}>
                  {row.enabled === 1 ? '停用' : '启用'}
                </button>
                <button className="text-red-600 underline" onClick={() => void remove(row)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={6}>暂无调度。</td>
            </tr>
          )}
        </tbody>
      </table>

      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded border p-3 text-sm">
        <label className="block">
          频率
          <select
            className="mt-1 block rounded border px-2 py-1"
            value={freqType}
            onChange={(e) => setFreqType(e.target.value as FreqType)}
          >
            {(Object.keys(FREQ_LABEL) as FreqType[]).map((f) => (
              <option key={f} value={f}>{FREQ_LABEL[f]}</option>
            ))}
          </select>
        </label>
        {freqType !== 'cron' && (
          <label className="block">
            时间
            <input
              type="time"
              className="mt-1 block rounded border px-2 py-1"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
            />
          </label>
        )}
        {freqType === 'weekly' && (
          <label className="block">
            星期
            <select
              className="mt-1 block rounded border px-2 py-1"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>{d}</option>
              ))}
            </select>
          </label>
        )}
        {freqType === 'monthly' && (
          <label className="block">
            日期
            <input
              type="number"
              min={1}
              max={31}
              className="mt-1 block w-20 rounded border px-2 py-1"
              value={monthDay}
              onChange={(e) => setMonthDay(Number(e.target.value))}
            />
          </label>
        )}
        {freqType === 'cron' && (
          <label className="block">
            Cron 表达式
            <input
              className="mt-1 block rounded border px-2 py-1 font-mono"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              required
            />
          </label>
        )}
        <label className="block">
          时区
          <input
            className="mt-1 block rounded border px-2 py-1"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? '保存中…' : '新增调度'}
        </button>
      </form>
    </section>
  );
}
