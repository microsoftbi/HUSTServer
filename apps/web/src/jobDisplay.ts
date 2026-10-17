import type { JobSummary } from './types.js';

/** 状态徽标色调（与 Badge 组件的 tone 对齐） */
export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Job 运行状态 → 徽标色调 */
export const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  queued: 'neutral',
  running: 'primary',
  success: 'success',
  error: 'danger',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'neutral',
};

/** 把 5 段 cron 翻译成人话；复杂表达式原样展示。 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom !== '*' && dow !== '*') return expr;
  if (dom !== '*') return `每月 ${dom} 日 ${time}`;
  if (dow === '*') return `每天 ${time}`;
  const days = dow.split(',').map((d) => WEEKDAYS[Number(d)] ?? d);
  return `每${days.join('、')} ${time}`;
}

/** Job 的调度配置文案；未启用或无 cron 时显示「未启用」。 */
export function describeSchedule(
  job: Pick<JobSummary, 'enabled' | 'cron_expr' | 'timezone'>,
): string {
  if (!job.enabled || !job.cron_expr) return '未启用';
  return `${describeCron(job.cron_expr)}（${job.timezone}）`;
}
