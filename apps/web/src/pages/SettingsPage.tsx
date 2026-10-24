import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Field, Input, Textarea } from '../components/ui/input.js';
import { PageHeader } from '../components/ui/page-header.js';

interface AdminSettings {
  maxConcurrentRuns: number;
  logRetentionDays: number;
  sharedDirs: string[];
  tz: string;
  assistant: {
    apiBase: string;
    model: string;
    hasApiKey: boolean;
  };
}

export function SettingsPage() {
  const { hasCap } = useAuth();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [sharedDirsText, setSharedDirsText] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
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

  if (!hasCap('admin')) return <p className="text-sm text-muted-foreground">无权访问。</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      const body = {
        maxConcurrentRuns: settings.maxConcurrentRuns,
        logRetentionDays: settings.logRetentionDays,
        tz: settings.tz,
        sharedDirs: sharedDirsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        assistantApiBase: settings.assistant.apiBase,
        assistantModel: settings.assistant.model,
        // 留空表示保持原有 Key 不变
        ...(apiKeyDraft.trim() ? { assistantApiKey: apiKeyDraft.trim() } : {}),
      };
      const next = await api.put<AdminSettings>('/api/admin/settings', { body });
      setSettings(next);
      setSharedDirsText(next.sharedDirs.join('\n'));
      setApiKeyDraft('');
      setError(null);
      window.alert('保存成功。并发数与保留期在服务重启后完全生效。');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="space-y-4">
      <PageHeader title="系统设置" description="数据库中的配置优先于环境变量默认值。">
        <Button type="submit" form="settings-form" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <form id="settings-form" onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>运行</CardTitle>
              <CardDescription>控制同时执行的工作流数量与运行日志的保留时长。</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="最大并发运行数">
              <Input
                type="number"
                min={1}
                className="w-32"
                value={settings.maxConcurrentRuns}
                onChange={(e) => setSettings({ ...settings, maxConcurrentRuns: Number(e.target.value) })}
              />
            </Field>
            <Field label="日志保留天数">
              <Input
                type="number"
                min={1}
                className="w-32"
                value={settings.logRetentionDays}
                onChange={(e) => setSettings({ ...settings, logRetentionDays: Number(e.target.value) })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>存储</CardTitle>
              <CardDescription>允许服务端路径输入引用的共享目录。</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Field label="共享目录" hint="每行一个目录。">
              <Textarea
                className="h-28 font-mono"
                value={sharedDirsText}
                onChange={(e) => setSharedDirsText(e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>时间</CardTitle>
              <CardDescription>调度与日志时间戳使用的默认时区。</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Field label="默认时区">
              <Input
                className="w-64"
                value={settings.tz}
                onChange={(e) => setSettings({ ...settings, tz: e.target.value })}
              />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>AI 智能体</CardTitle>
              <CardDescription>
                用于「AI 智能体」自然语言查询数据模型（Text2SQL）的大模型接口配置。API Key 加密保存在数据库中，不会回显。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="API 地址" hint="兼容 OpenAI 协议的地址，默认 https://api.deepseek.com">
              <Input
                className="w-full max-w-md"
                value={settings.assistant.apiBase}
                onChange={(e) =>
                  setSettings({ ...settings, assistant: { ...settings.assistant, apiBase: e.target.value } })
                }
              />
            </Field>
            <Field label="模型名称" hint="例如 deepseek-chat">
              <Input
                className="w-64"
                value={settings.assistant.model}
                onChange={(e) =>
                  setSettings({ ...settings, assistant: { ...settings.assistant, model: e.target.value } })
                }
              />
            </Field>
            <Field
              label="API Key"
              hint={settings.assistant.hasApiKey ? '已配置。留空表示不修改。' : '尚未配置，填写后才能使用 AI 智能体。'}
            >
              <Input
                type="password"
                autoComplete="new-password"
                className="w-full max-w-md"
                placeholder={settings.assistant.hasApiKey ? '••••••••（留空不修改）' : 'sk-...'}
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
              />
            </Field>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
