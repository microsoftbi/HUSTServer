import { ArrowLeft, LayoutDashboard, Loader2, Play, Redo2, Save, Settings, Undo2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';

export interface JobToolbarProps {
  name: string;
  dirty: boolean;
  /** 运行中锁定编辑。 */
  locked: boolean;
  saving: boolean;
  running: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onOpenSettings: () => void;
  onSave: () => void;
  onRun: () => void;
}

export function JobToolbar({
  name,
  dirty,
  locked,
  saving,
  running,
  canUndo,
  canRedo,
  onBack,
  onUndo,
  onRedo,
  onAutoLayout,
  onOpenSettings,
  onSave,
  onRun,
}: JobToolbarProps) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
      <Button variant="ghost" size="icon" onClick={onBack} title="返回 Job 列表">
        <ArrowLeft />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium" title={name || '未命名 Job'}>
          {name || '未命名 Job'}
        </span>
        {dirty && <span className="shrink-0 text-[10px] text-muted-foreground">未保存</span>}
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={onUndo} disabled={!canUndo || locked} title="撤销（⌘Z）">
          <Undo2 />
        </Button>
        <Button variant="ghost" size="icon" onClick={onRedo} disabled={!canRedo || locked} title="重做（⇧⌘Z）">
          <Redo2 />
        </Button>
        <Button variant="ghost" size="icon" onClick={onAutoLayout} disabled={locked} title="整理布局">
          <LayoutDashboard />
        </Button>
      </div>

      <div className="mx-1 h-5 w-px bg-border" />

      <Button variant="ghost" size="sm" onClick={onOpenSettings} title="Job 名称、描述与调度">
        <Settings />
        设置
      </Button>

      <Button variant="outline" size="sm" onClick={onSave} disabled={saving || locked}>
        {saving ? <Loader2 className="animate-spin" /> : <Save />}
        保存
      </Button>
      <Button size="sm" onClick={onRun} disabled={running || saving || dirty} title={dirty ? '请先保存' : '运行 Job'}>
        {running ? <Loader2 className="animate-spin" /> : <Play />}
        {running ? '运行中' : '运行'}
      </Button>
    </header>
  );
}
