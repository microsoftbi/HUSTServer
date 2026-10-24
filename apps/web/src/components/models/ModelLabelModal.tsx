import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiClientError } from '../../api.js';
import { MarkdownEditor } from '../markdown-editor.js';
import { Button } from '../ui/button.js';
import { ErrorNote } from '../ui/error-note.js';

interface LabelResponse {
  name: string;
  content: string;
  updatedAt: number | null;
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/**
 * 数据标签弹窗：顶部工具条提供保存，主体为 Markdown 编辑器。
 * 保存后留在弹窗内（可继续编辑）；清空内容保存即删除标签。
 */
export function ModelLabelModal({
  open,
  modelName,
  onClose,
  onSaved,
}: {
  open: boolean;
  modelName: string;
  onClose: () => void;
  onSaved?: (hasLabel: boolean) => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !modelName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    setContent('');
    void api
      .get<LabelResponse>(`/api/models/${encodeURIComponent(modelName)}/label`)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setSavedAt(res.updatedAt);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, modelName]);

  async function save(): Promise<void> {
    if (saving || loading) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.put<{ ok: boolean; hasLabel: boolean }>(
        `/api/models/${encodeURIComponent(modelName)}/label`,
        { body: { content } },
      );
      setSavedAt(Date.now());
      onSaved?.(res.hasLabel);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd + S 保存
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-14"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col rounded-lg border border-border bg-card text-card-foreground shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-sm font-semibold">数据标签 · {modelName}</h2>
            {savedAt !== null && (
              <span className="shrink-0 text-xs text-muted-foreground">
                已保存 {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" disabled={saving || loading} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <button
              type="button"
              aria-label="关闭"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-2 p-4">
          {error && <ErrorNote>{error}</ErrorNote>}
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">读取标签…</p>
          ) : (
            <MarkdownEditor
              value={content}
              onChange={setContent}
              height={340}
              placeholder={'用 Markdown 记录这个模型的业务口径、注意事项等，例如：\n\n## 业务口径\n\n- 订单金额已含税\n- 渠道字段取值：线上 / 线下 / 分销'}
            />
          )}
          <p className="text-xs text-muted-foreground">
            支持 Markdown 语法（标题、列表、表格、代码块等）；清空内容后保存即删除该标签。
          </p>
          <p className="text-xs text-muted-foreground">
            数据标签会提供给 AI，让其更懂数据模型的结构和数据。
          </p>
        </div>
      </div>
    </div>
  );
}
