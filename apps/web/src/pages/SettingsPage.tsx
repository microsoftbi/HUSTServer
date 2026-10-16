import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';

interface AdminSettings {
  maxConcurrentRuns: number;
  logRetentionDays: number;
  sharedDirs: string[];
  tz: string;
}

export function SettingsPage() {
  const { hasCap } = useAuth();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [sharedDirsText, setSharedDirsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.get<AdminSettings>('/api/admin/settings');
      setSettings(s);
      setSharedDirsText(s.sharedDirs.join('\n'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (hasCap('admin')) void load();
  }, [hasCap, load]);

  if (!hasCap('admin')) return <p className="text-sm text-slate-500">无权访问。</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setNotice(null);
    try {
      const body: AdminSettings = {
        ...settings,
        sharedDirs: sharedDirsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      const next = await api.put<AdminSettings>('/api/admin/settings', { body });
      setSettings(next);
      setSharedDirsText(next.sharedDirs.join('\n'));
      setNotice('已保存（并发数与保留期在服务重启后完全生效）');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">系统设置</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-green-700">{notice}</p>}

      <form onSubmit={submit} className="max-w-xl space-y-3 rounded border p-4 text-sm">
        <label className="block">
          最大并发运行数
          <input
            type="number"
            min={1}
            className="mt-1 block w-32 rounded border px-2 py-1"
            value={settings.maxConcurrentRuns}
            onChange={(e) => setSettings({ ...settings, maxConcurrentRuns: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          日志保留天数
          <input
            type="number"
            min={1}
            className="mt-1 block w-32 rounded border px-2 py-1"
            value={settings.logRetentionDays}
            onChange={(e) => setSettings({ ...settings, logRetentionDays: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          共享目录（每行一个，允许服务端路径输入引用）
          <textarea
            className="mt-1 block h-28 w-full rounded border px-2 py-1 font-mono"
            value={sharedDirsText}
            onChange={(e) => setSharedDirsText(e.target.value)}
          />
        </label>
        <label className="block">
          默认时区
          <input
            className="mt-1 block w-64 rounded border px-2 py-1"
            value={settings.tz}
            onChange={(e) => setSettings({ ...settings, tz: e.target.value })}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存设置'}
        </button>
      </form>
    </div>
  );
}
