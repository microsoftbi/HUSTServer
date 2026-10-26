import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Terminal } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { RUN_STATUS_TONE } from '../../jobDisplay.js';
import type { JobRunSummary, JobStepRunSummary } from '../../types.js';
import { STATUS_LABEL, StepDetail, TYPE_LABEL } from './JobRunSteps.js';

export interface JobRunOutputPanelProps {
  run: JobRunSummary | null;
  steps: JobStepRunSummary[];
  /** 是否有可展示的运行（新建未保存的 Job 为 false）。 */
  hasJob: boolean;
  /** 正在运行：显示加载中的占位，避免尚无步骤时误报「暂无记录」。 */
  active?: boolean;
}

/** 编辑器底部「运行输出」：只展示最近一次运行的分步结果与详细日志，运行中自动刷新。 */
export function JobRunOutputPanel({ run, steps, hasJob, active = false }: JobRunOutputPanelProps) {
  const [open, setOpen] = useState(true);
  const running = active || run?.status === 'queued' || run?.status === 'running';

  return (
    <div className="shrink-0">
      <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex min-w-0 items-center gap-2 transition-colors hover:text-foreground"
        >
          <Terminal className="size-3.5" />
          运行输出
          {running && <Loader2 className="size-3 animate-spin text-primary" />}
          {run && (
            <Badge dot tone={RUN_STATUS_TONE[run.status] ?? 'neutral'} className="ml-1">
              {STATUS_LABEL[run.status] ?? run.status}
            </Badge>
          )}
          {run && (
            <span>
              {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
              {run.duration_ms != null && ` · ${run.duration_ms} ms`}
            </span>
          )}
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
        {run && (
          <Link
            to={`/job-runs/${run.id}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-primary"
          >
            运行详情
            <ExternalLink className="size-3" />
          </Link>
        )}
      </div>

      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-border">
          {!hasJob ? (
            <div className="px-3 py-3 text-muted-foreground">保存并运行后可查看输出。</div>
          ) : !run ? (
            <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground">
              {running && <Loader2 className="size-3.5 animate-spin" />}
              {running ? '等待步骤输出…' : '尚未运行过，点击右上角「运行」后可查看输出。'}
            </div>
          ) : steps.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground">
              {running && <Loader2 className="size-3.5 animate-spin" />}
              {running ? '等待步骤输出…' : '暂无步骤记录'}
            </div>
          ) : (
            steps.map((step) => (
              <div
                key={step.id}
                className="border-b border-border/60 px-3 py-2 text-xs last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-muted-foreground">{step.seq + 1}</span>
                  <Badge dot tone={RUN_STATUS_TONE[step.status] ?? 'neutral'} className="shrink-0">
                    {STATUS_LABEL[step.status] ?? step.status}
                  </Badge>
                  <span className="min-w-0 truncate font-medium" title={step.name}>
                    {step.name}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{TYPE_LABEL[step.type] ?? step.type}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {step.duration_ms != null ? `${step.duration_ms} ms` : '—'}
                  </span>
                </div>
                <div className="mt-1 space-y-1 pl-7">
                  <StepDetail
                    step={step}
                    live={step.status === 'running'}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
