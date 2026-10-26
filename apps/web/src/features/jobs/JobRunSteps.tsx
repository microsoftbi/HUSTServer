import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api.js';
import type { JobStepRunSummary } from '../../types.js';

/** 运行/步骤状态的中文文案。 */
export const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  canceled: '已取消',
  skipped: '已跳过',
};

/** 步骤类型的中文文案。 */
export const TYPE_LABEL: Record<string, string> = {
  workflow: '工作流',
  sql: 'SQL',
  load_model: '加载成模型',
};

interface LogItem {
  id: number;
  ts: number;
  level: string;
  node_id: string | null;
  message: string;
}

const LOG_LIMIT = 200;
const LOG_POLL_MS = 2000;

/** 工作流步骤的子运行日志：直接展开显示；子运行进行中时轮询刷新。 */
export function StepLogs({ runId, live }: { runId: string; live: boolean }) {
  const [logs, setLogs] = useState<LogItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchLogs = () => {
      api
        .get<{ items: LogItem[] }>(`/api/runs/${runId}/logs?limit=${LOG_LIMIT}`)
        .then((res) => {
          if (cancelled) return;
          setLogs(res.items);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    fetchLogs();
    if (!live) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(fetchLogs, LOG_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId, live]);

  if (failed) return <div className="text-destructive">日志加载失败</div>;
  if (logs === null) return <div className="text-muted-foreground">日志加载中…</div>;
  if (logs.length === 0) return <div className="text-muted-foreground">该工作流没有输出日志。</div>;
  return (
    <>
      {logs.map((log) => (
        <div key={log.id} className="break-all">
          <span className="text-muted-foreground">[{new Date(log.ts).toLocaleTimeString()}]</span>{' '}
          <span className={log.level === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
            {log.level}
          </span>{' '}
          {log.node_id && <span className="text-primary">{log.node_id} </span>}
          <span>{log.message}</span>
        </div>
      ))}
    </>
  );
}

/** 单个步骤的输出：摘要 +（工作流）子运行日志 + 错误。 */
export function StepDetail({ step, live }: { step: JobStepRunSummary; live: boolean }) {
  let runId: string | null = null;
  let summary: ReactNode = null;
  if (step.output) {
    try {
      const parsed = JSON.parse(step.output) as {
        runId?: string;
        rowsAffected?: number;
        rowCount?: number;
        modelName?: string;
      };
      if (step.type === 'workflow' && parsed.runId) {
        runId = parsed.runId;
      } else if (typeof parsed.rowsAffected === 'number' || typeof parsed.rowCount === 'number') {
        summary = (
          <span>
            影响 {parsed.rowsAffected ?? 0} 行 · 返回 {parsed.rowCount ?? 0} 行
          </span>
        );
      } else if (parsed.modelName) {
        summary = (
          <span>
            {parsed.modelName} · {parsed.rowCount ?? 0} 行
          </span>
        );
      }
    } catch {
      /* 非 JSON 输出按原文展示 */
    }
  }

  return (
    <div className="space-y-1">
      {summary && <div className="text-muted-foreground">{summary}</div>}
      {runId && <StepLogs runId={runId} live={live} />}
      {!summary && !runId && step.output && (
        <div className="break-all font-mono text-[11px]">{step.output}</div>
      )}
      {step.error && <div className="break-all text-destructive">{step.error}</div>}
    </div>
  );
}
