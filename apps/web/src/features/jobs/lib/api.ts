import type {
  JobDetail, JobEdge, JobNode, JobNodeMode, JobOnFailure, JobStepType,
} from '../../../types.js';

export interface ScheduleForm {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron';
  time: string;
  weekday: number;
  monthDay: number;
  cronExpr: string;
  timezone: string;
}

export const DEFAULT_SCHEDULE: ScheduleForm = {
  enabled: false,
  freqType: 'daily',
  time: '08:00',
  weekday: 1,
  monthDay: 1,
  cronExpr: '0 8 * * *',
  timezone: 'Asia/Shanghai',
};

/** 把 DB 里的调度字段反解回表单；解析不出预设时回退为 cron 模式。 */
export function cronToForm(
  freqType: string | null,
  cronExpr: string | null,
  timezone: string,
  enabled: boolean,
): ScheduleForm {
  const base: ScheduleForm = { ...DEFAULT_SCHEDULE, timezone, enabled };
  if (!freqType || !cronExpr) return base;
  if (freqType === 'cron') return { ...base, freqType: 'cron', cronExpr };
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, freqType: 'cron', cronExpr };
  const [min, hour] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (freqType === 'daily') return { ...base, freqType: 'daily', time };
  if (freqType === 'weekly') {
    const dow = Number(parts[4]);
    return { ...base, freqType: 'weekly', time, weekday: Number.isInteger(dow) ? dow : 1 };
  }
  const dom = Number(parts[2]);
  return { ...base, freqType: 'monthly', time, monthDay: Number.isInteger(dom) ? dom : 1 };
}

/** 请求体里的节点：配置字段平铺（与后端 parseNodeConfig 对齐）。 */
export interface JobNodeBody {
  key: string;
  type: JobStepType;
  name: string;
  onFailure: JobOnFailure;
  mode: JobNodeMode;
  x: number;
  y: number;
  [field: string]: unknown;
}

export interface JobBody {
  name: string;
  description: string | null;
  nodes: JobNodeBody[];
  edges: JobEdge[];
  schedule:
    | { enabled: false }
    | {
        enabled: true;
        freqType: ScheduleForm['freqType'];
        time: string;
        weekday: number;
        monthDay: number;
        cronExpr: string;
        timezone: string;
      };
}

/** 画布编辑器持有的完整草稿（与保存请求体同构，节点配置单独存放）。 */
export interface JobDraft {
  name: string;
  description: string;
  nodes: JobNode[];
  edges: JobEdge[];
  schedule: ScheduleForm;
}

/** 服务端详情 → 编辑器草稿。 */
export function fromDetail(job: JobDetail): JobDraft {
  return {
    name: job.name,
    description: job.description ?? '',
    nodes: job.nodes.map((n, index) => ({
      ...n,
      seq: index,
      config: { ...n.config },
    })),
    edges: job.edges.map((e) => ({ source: e.source, target: e.target })),
    schedule: cronToForm(job.schedule.freqType, job.schedule.cronExpr, job.schedule.timezone, job.schedule.enabled),
  };
}

/** 编辑器草稿 → 保存请求体。 */
export function toBody(draft: JobDraft): JobBody {
  const { schedule } = draft;
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    nodes: draft.nodes.map((n, index) => ({
      key: n.key,
      type: n.type,
      name: n.name.trim() || n.key,
      onFailure: n.onFailure,
      mode: n.mode,
      x: n.x,
      y: n.y,
      seq: index,
      ...n.config,
    })),
    edges: draft.edges.map((e) => ({ source: e.source, target: e.target })),
    schedule: schedule.enabled
      ? {
          enabled: true,
          freqType: schedule.freqType,
          time: schedule.time,
          weekday: schedule.weekday,
          monthDay: schedule.monthDay,
          cronExpr: schedule.cronExpr,
          timezone: schedule.timezone,
        }
      : { enabled: false },
  };
}

/** 生成 Job 内唯一的节点标识。 */
export function newNodeKey(taken: Iterable<string>): string {
  const used = new Set(taken);
  let key = '';
  do {
    key = `n_${Math.random().toString(36).slice(2, 10)}`;
  } while (used.has(key));
  return key;
}
