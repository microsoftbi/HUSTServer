import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDesignerHost } from '@/context';
import { useWorkflowStore } from '@/store/workflowStore';

export function Toolbar() {
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const setWorkflowName = useWorkflowStore((s) => s.setWorkflowName);
  const dirty = useWorkflowStore((s) => s.dirty);
  const { adapter, onExit } = useDesignerHost();
  const snapshot = useWorkflowStore((s) => s.snapshot);
  const markSaved = useWorkflowStore((s) => s.markSaved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await adapter.onSave(snapshot());
      markSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/60 px-3">
      {onExit && (
        <Button variant="ghost" size="sm" onClick={() => onExit?.()}>
          返回
        </Button>
      )}

      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
          HX
        </div>
        <span className="text-sm font-semibold">HUSTERYX</span>
      </div>

      <div className="mx-2 h-6 w-px bg-border" />

      <Input
        value={workflowName}
        onChange={(event) => setWorkflowName(event.target.value)}
        className="h-8 w-64"
        placeholder="工作流名称"
      />
      {dirty && (
        <Badge variant="warning" className="shrink-0">
          未保存
        </Badge>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>

        {saveError && <span className="text-xs text-destructive">{saveError}</span>}
      </div>
    </header>
  );
}
