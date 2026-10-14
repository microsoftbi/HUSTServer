import cronParser from 'cron-parser';

export type FreqType = 'daily' | 'weekly' | 'monthly' | 'cron';

export const FREQ_TYPES: readonly FreqType[] = ['daily', 'weekly', 'monthly', 'cron'];

export function isFreqType(value: unknown): value is FreqType {
  return typeof value === 'string' && (FREQ_TYPES as readonly string[]).includes(value);
}

export class CronFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronFormatError';
  }
}

export interface PresetInput {
  freqType: FreqType;
  /** HH:MM，24 小时制 */
  time?: string;
  /** 0–6，0=周日 */
  weekday?: number;
  /** 1–31 */
  monthDay?: number;
  cronExpr?: string;
}

function parseTime(time: string | undefined): { hour: number; minute: number } {
  const matched = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!matched) throw new CronFormatError('时间格式应为 HH:MM');
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) throw new CronFormatError('时间超出范围');
  return { hour, minute };
}

/** 预设（daily/weekly/monthly）或原生 cron 统一归一为 5 段标准 cron 表达式。 */
export function presetToCron(input: PresetInput): string {
  switch (input.freqType) {
    case 'daily': {
      const { hour, minute } = parseTime(input.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekly': {
      const { hour, minute } = parseTime(input.time);
      const weekday = input.weekday;
      if (weekday === undefined || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new CronFormatError('weekday 应为 0–6 的整数');
      }
      return `${minute} ${hour} * * ${weekday}`;
    }
    case 'monthly': {
      const { hour, minute } = parseTime(input.time);
      const monthDay = input.monthDay;
      if (monthDay === undefined || !Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
        throw new CronFormatError('monthDay 应为 1–31 的整数');
      }
      return `${minute} ${hour} ${monthDay} * *`;
    }
    case 'cron': {
      const expr = (input.cronExpr ?? '').trim();
      if (!expr) throw new CronFormatError('cron 表达式不能为空');
      return expr;
    }
  }
}

export function validateCron(expr: string, timezone: string): boolean {
  if (!expr.trim()) return false;
  try {
    cronParser.parseExpression(expr, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

/** 返回 from 之后的下一次触发时间戳（毫秒）；表达式非法或时区无效时返回 null。 */
export function nextRunAt(expr: string, timezone: string, from: number = Date.now()): number | null {
  try {
    const it = cronParser.parseExpression(expr, { currentDate: new Date(from), tz: timezone });
    return it.next().toDate().getTime();
  } catch {
    return null;
  }
}
