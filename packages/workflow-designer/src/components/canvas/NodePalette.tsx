import { useState } from 'react';
import { Info, Settings } from 'lucide-react';
import { CATEGORY_ACCENT, NODE_CATEGORY_LABEL, NODE_META, type NodeCategory } from '@/lib/nodeMeta';
import { AboutDialog } from '@/components/settings/AboutDialog';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useWorkflowStore } from '@/store/workflowStore';
import { cn } from '@/lib/utils';

const CATEGORIES: NodeCategory[] = ['input', 'transform', 'output'];

/** 顶部 ribbon：按类别分区展示可拖拽节点，组内为按钮、底部为组名，组间以竖线分隔，横向可滚动。 */
export function NodePalette() {
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const running = runStatus === 'running';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <div className="flex h-16 shrink-0 items-stretch border-b border-border bg-card/40 px-3">
      <div className="flex min-w-0 flex-1 items-stretch gap-3 overflow-x-auto">
        {CATEGORIES.map((category, index) => (
          <div key={category} className="flex shrink-0 items-stretch gap-3">
            {index > 0 && <div className="my-2 w-px shrink-0 bg-border" />}
            <div className="flex shrink-0 flex-col justify-center gap-1">
              <div className="flex items-center gap-1.5">
                {Object.values(NODE_META)
                  .filter((meta) => meta.category === category)
                  .map((meta) => {
                    const Icon = meta.icon;
                    return (
                      <div
                        key={meta.kind}
                        draggable={!running}
                        title={running ? '运行中，暂不可添加节点' : meta.description}
                        onDragStart={(event) => {
                          if (running) return;
                          event.dataTransfer.setData('application/husteryx-node', meta.kind);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        className={cn(
                          'flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 transition-colors',
                          running
                            ? 'cursor-not-allowed opacity-50 grayscale'
                            : 'cursor-grab hover:border-primary/60 hover:bg-accent active:cursor-grabbing',
                        )}
                      >
                        <div
                          className={cn(
                            'flex size-5 shrink-0 items-center justify-center rounded text-white',
                            CATEGORY_ACCENT[category],
                          )}
                        >
                          <Icon className="size-3" />
                        </div>
                        <span className="whitespace-nowrap text-xs font-medium">{meta.label}</span>
                      </div>
                    );
                  })}
              </div>
              <span className="text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {NODE_CATEGORY_LABEL[category]}
              </span>
            </div>
          </div>
        ))}

        <div className="flex shrink-0 items-stretch gap-3">
          <div className="my-2 w-px shrink-0 bg-border" />
          <div className="flex shrink-0 flex-col justify-center gap-1">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="系统配置"
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 transition-colors hover:border-primary/60 hover:bg-accent"
              >
                <div className="flex size-5 shrink-0 items-center justify-center rounded bg-slate-500 text-white">
                  <Settings className="size-3" />
                </div>
                <span className="whitespace-nowrap text-xs font-medium">配置</span>
              </button>
              <button
                type="button"
                onClick={() => setAboutOpen(true)}
                title="关于"
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 transition-colors hover:border-primary/60 hover:bg-accent"
              >
                <div className="flex size-5 shrink-0 items-center justify-center rounded bg-sky-500 text-white">
                  <Info className="size-3" />
                </div>
                <span className="whitespace-nowrap text-xs font-medium">关于</span>
              </button>
            </div>
            <span className="text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              系统
            </span>
          </div>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      {running && (
        <span className="ml-3 shrink-0 self-center text-[10px] text-muted-foreground">
          运行中，画布与配置已锁定。
        </span>
      )}
    </div>
  );
}
