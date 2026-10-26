import { useState } from 'react';
import { Loader2, Play, Redo2, Save, Square, Undo2 } from 'lucide-react';
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

  const workflowId = useWorkflowStore((s) => s.workflowId);
  const nodeCount = useWorkflowStore((s) => s.nodes.length);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const runHost = useWorkflowStore((s) => s.runHost);
  const run = useWorkflowStore((s) => s.run);
  const cancel = useWorkflowStore((s) => s.cancel);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const canUndo = useWorkflowStore((s) => s.past.length > 0);
  const canRedo = useWorkflowStore((s) => s.future.length > 0);

  const running = runStatus === 'running';
  const runDisabled = !workflowId || nodeCount === 0 || running || !runHost;
  const runHint = !workflowId
    ? '请先保存工作流'
    : nodeCount === 0
      ? '请先添加节点'
      : !runHost
        ? '当前宿主不支持运行'
        : undefined;

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

      <div className="mx-1 h-6 w-px bg-border" />

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={undo}
        disabled={!canUndo || running}
        title="撤销（⌘/Ctrl + Z）"
      >
        <Undo2 className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={redo}
        disabled={!canRedo || running}
        title="重做（⌘/Ctrl + Shift + Z）"
      >
        <Redo2 className="size-3.5" />
      </Button>

      <div className="ml-auto flex items-center gap-2">
        {runStatus === 'success' && <Badge variant="success">运行成功</Badge>}
        {runStatus === 'error' && <Badge variant="destructive">运行失败</Badge>}
        {runStatus === 'canceled' && <Badge variant="secondary">已取消</Badge>}

        {running ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void cancel()}
            disabled={!runHost?.cancelRun}
            title={
              runHost?.cancelRun
                ? '取消运行：当前节点执行结束后停止'
                : '当前宿主不支持取消运行'
            }
          >
            <Square />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={() => void run()} disabled={runDisabled} title={runHint}>
            <Play />
            运行
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>

        {saveError && <span className="text-xs text-destructive">{saveError}</span>}
      </div>
    </header>
  );
}
