import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkflowStore } from '@/store/workflowStore';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { RunLogEvent } from '@/types';

const LEVEL_CLASS: Record<RunLogEvent['level'], string> = {
  info: 'text-muted-foreground',
  warn: 'text-[var(--warning)]',
  error: 'text-destructive',
  success: 'text-[var(--success)]',
};

/** 运行日志内容视图（嵌入底部面板的「运行日志」选项卡）。 */
export function RunLogView() {
  const logs = useWorkflowStore((s) => s.logs);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const clearLogs = useWorkflowStore((s) => s.clearLogs);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">{logs.length} 条</span>
        {runStatus === 'running' && <span className="text-[11px] text-primary">运行中…</span>}
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={logs.length === 0}
            onClick={clearLogs}
            title="清空日志"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {logs.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground">暂无日志</div>
        ) : (
          <div className="flex flex-col gap-0.5 font-mono text-[11px] leading-relaxed">
            {logs.map((log, index) => (
              <div key={index} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground/60">{formatTime(log.ts)}</span>
                <span className={cn('min-w-0 whitespace-pre-wrap break-all', LEVEL_CLASS[log.level])}>
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
