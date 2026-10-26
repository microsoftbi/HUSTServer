import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Field, Input, Textarea } from '../components/ui/input.js';
import { PageHeader } from '../components/ui/page-header.js';
import { CANVAS_THEMES, type CanvasThemeId } from '../features/theme/themes.js';
import { useCanvasThemeStore } from '../features/theme/themeStore.js';
import { UI_THEMES, type UiThemeId } from '../features/theme/uiThemes.js';
import { useUiThemeStore } from '../features/theme/uiThemeStore.js';

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
  canvasTheme: CanvasThemeId;
  uiTheme: UiThemeId;
}

interface ThemeOption {
  id: string;
  label: string;
  description: string;
  preview: { background: string; card: string; border: string };
}

/** 主题缩略图：用主题自身的三个变量铺一个小画布示意。 */
function ThemeSwatch({ preview }: { preview: ThemeOption['preview'] }) {
  return (
    <div
      className="flex h-14 w-full items-center justify-center gap-1.5 rounded-md border"
      style={{ background: preview.background, borderColor: preview.border }}
    >
      <span className="h-6 w-10 rounded-sm" style={{ background: preview.card }} />
      <span className="h-6 w-10 rounded-sm" style={{ background: preview.card }} />
      <span className="h-6 w-6 rounded-full" style={{ background: preview.card }} />
    </div>
  );
}

function ThemePicker<T extends string>({
  options,
  value,
  onChange,
  allowFollow,
}: {
  options: ThemeOption[];
  value: T | null;
  onChange: (id: T | null) => void;
  allowFollow?: boolean;
}) {
  const themed = options as Array<Omit<ThemeOption, 'id'> & { id: T }>;
  const entries: Array<{ id: T | null; label: string; description: string; preview?: ThemeOption['preview'] }> =
    allowFollow
      ? [{ id: null, label: '跟随系统设置', description: '使用下方保存的系统默认主题。' }, ...themed]
      : themed;
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {entries.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id ?? 'follow'}
            type="button"
            onClick={() => onChange(option.id)}
            className={`rounded-lg border p-2 text-left transition-colors ${
              active ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50'
            }`}
          >
            {option.preview ? (
              <ThemeSwatch preview={option.preview} />
            ) : (
              <div className="flex h-14 w-full items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground">
                自动
              </div>
            )}
            <div className="mt-2 text-xs font-medium">{option.label}</div>
            <div className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-muted-foreground">
              {option.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPage() {
  const { hasCap } = useAuth();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [sharedDirsText, setSharedDirsText] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 本机覆盖（立即生效，仅当前浏览器）；null 表示跟随系统设置。
  const [localTheme, setLocalTheme] = useState<CanvasThemeId | null>(
    () => useCanvasThemeStore.getState().override,
  );
  const [localUiTheme, setLocalUiTheme] = useState<UiThemeId | null>(
    () => useUiThemeStore.getState().override,
  );

  const applyLocalTheme = (id: CanvasThemeId | null) => {
    useCanvasThemeStore.getState().setOverride(id);
    setLocalTheme(id);
  };

  const applyLocalUiTheme = (id: UiThemeId | null) => {
    useUiThemeStore.getState().setOverride(id);
    setLocalUiTheme(id);
  };

  const load = useCallback(async () => {
    try {
      const s = await api.get<AdminSettings>('/api/admin/settings');
      setSettings(s);
      setSharedDirsText(s.sharedDirs.join('\n'));
      useCanvasThemeStore.getState().setSystem(s.canvasTheme);
      useUiThemeStore.getState().setSystem(s.uiTheme);
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
        canvasTheme: settings.canvasTheme,
        uiTheme: settings.uiTheme,
        // 留空表示保持原有 Key 不变
        ...(apiKeyDraft.trim() ? { assistantApiKey: apiKeyDraft.trim() } : {}),
      };
      const next = await api.put<AdminSettings>('/api/admin/settings', { body });
      setSettings(next);
      useCanvasThemeStore.getState().setSystem(next.canvasTheme);
      useUiThemeStore.getState().setSystem(next.uiTheme);
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
              <CardTitle>界面外观</CardTitle>
              <CardDescription>
                整个界面（导航、列表、表单等）的配色主题，与下方画布主题分开配置。系统默认对所有用户生效；本机偏好只影响当前浏览器，优先于系统设置。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">系统默认主题</div>
              <ThemePicker
                options={UI_THEMES}
                value={settings.uiTheme}
                onChange={(id) => id && setSettings({ ...settings, uiTheme: id })}
              />
              <p className="text-xs text-muted-foreground">修改后点击右上角「保存」写入系统设置。</p>
            </div>
            <div className="space-y-2 border-t border-border pt-4">
              <div className="text-xs font-medium text-muted-foreground">本机偏好（仅当前浏览器）</div>
              <ThemePicker options={UI_THEMES} value={localUiTheme} onChange={applyLocalUiTheme} allowFollow />
              <p className="text-xs text-muted-foreground">
                选择后立即生效并保存到本地，与画布主题的本机偏好互不影响。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="space-y-1">
              <CardTitle>画布外观</CardTitle>
              <CardDescription>
                工作流设计器与 Job 编排共用的配色主题。系统默认对所有用户生效；本机偏好只影响当前浏览器，优先于系统设置。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">系统默认主题</div>
              <ThemePicker
                options={CANVAS_THEMES}
                value={settings.canvasTheme}
                onChange={(id) => id && setSettings({ ...settings, canvasTheme: id })}
              />
              <p className="text-xs text-muted-foreground">修改后点击右上角「保存」写入系统设置。</p>
            </div>
            <div className="space-y-2 border-t border-border pt-4">
              <div className="text-xs font-medium text-muted-foreground">本机偏好（仅当前浏览器）</div>
              <ThemePicker options={CANVAS_THEMES} value={localTheme} onChange={applyLocalTheme} allowFollow />
              <p className="text-xs text-muted-foreground">选择后立即保存到本地，下次进入编辑器生效。</p>
            </div>
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
