import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, Loader2, PowerOff, SkipForward } from 'lucide-react';
import { cn } from '../../../components/ui/utils.js';
import type { JobNode } from '../../../types.js';
import { JOB_NODE_META } from '../lib/nodeMeta.js';

export type JobNodeStatus = 'idle' | 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'canceled';

export interface JobNodeData extends Record<string, unknown> {
  node: JobNode;
  summary: string;
  issues: string[];
  status: JobNodeStatus;
  /** 因上游禁用而被动不执行（与主动禁用区分文案）。 */
  upstreamDisabled: boolean;
  /** 运行中锁定编辑。 */
  locked: boolean;
}

const STATUS_RING: Record<JobNodeStatus, string> = {
  idle: 'border-border',
  pending: 'border-border',
  running: 'border-warning shadow-[0_0_0_3px_color-mix(in_oklch,var(--warning)_28%,transparent)]',
  success: 'border-[var(--success)]',
  error: 'border-destructive',
  skipped: 'border-border',
  canceled: 'border-[var(--warning)]',
};

export function JobNodeCard({ data, selected }: NodeProps) {
  const { node, summary, issues, status, upstreamDisabled, locked } = data as unknown as JobNodeData;
  const meta = JOB_NODE_META[node.type];
  const Icon = meta.icon;
  const disabled = node.mode === 'disable' || upstreamDisabled;
  const skipped = node.mode === 'skip';
  const dimmed = disabled || skipped || status === 'skipped';

  return (
    <div
      className={cn(
        'relative w-52 rounded-md border-2 bg-card text-card-foreground shadow-md transition-all',
        STATUS_RING[status],
        dimmed && 'opacity-60',
        disabled && 'border-dashed grayscale',
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
      )}
    >
      {issues.length > 0 && !disabled && (
        <div
          className="absolute -right-1.5 -top-1.5 z-10 flex size-4 items-center justify-center rounded-full bg-[var(--warning)] text-[9px] font-bold leading-none text-black shadow"
          title={`配置未完成：${issues.join('、')}`}
        >
          !
        </div>
      )}
      <div className={cn('h-0.5 w-full rounded-t-sm', meta.accent)} />
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <div className={cn('flex size-5 shrink-0 items-center justify-center rounded text-white', meta.accent)}>
          <Icon className="size-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium leading-tight" title={node.name}>
            {node.name}
          </div>
          <div className="truncate text-[10px] leading-tight text-muted-foreground">{meta.label}</div>
        </div>
        {status === 'running' && <Loader2 className="size-3.5 shrink-0 animate-spin text-warning" />}
        {status === 'success' && <CheckCircle2 className="size-3.5 shrink-0 text-[var(--success)]" />}
        {status === 'error' && <AlertTriangle className="size-3.5 shrink-0 text-destructive" />}
        {status === 'skipped' && <SkipForward className="size-3.5 shrink-0 text-muted-foreground" />}
        {status === 'canceled' && <PowerOff className="size-3.5 shrink-0 text-[var(--warning)]" />}
      </div>
      <div className="truncate border-t border-border px-2 py-1 text-[10px] text-muted-foreground" title={summary}>
        {summary}
      </div>
      {(node.onFailure === 'continue' || skipped || disabled) && (
        <div className="flex flex-wrap gap-1 border-t border-border px-2 py-1">
          {node.onFailure === 'continue' && (
            <span className="rounded bg-[var(--warning)]/20 px-1.5 py-px text-[9px] font-medium text-[var(--warning)]">
              失败继续
            </span>
          )}
          {skipped && (
            <span className="rounded bg-[var(--warning)]/20 px-1.5 py-px text-[9px] font-medium text-[var(--warning)]">
              跳过
            </span>
          )}
          {disabled && (
            <span className="rounded bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
              {node.mode === 'disable' ? '禁用（含下游）' : '上游禁用'}
            </span>
          )}
        </div>
      )}

      <Handle type="target" position={Position.Left} className={cn(locked && 'pointer-events-none')} />
      <Handle type="source" position={Position.Right} className={cn(locked && 'pointer-events-none')} />
    </div>
  );
}

export const jobNodeTypes = { job: JobNodeCard } satisfies NodeTypes;
