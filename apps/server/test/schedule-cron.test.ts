import { describe, expect, it } from 'vitest';
import {
  CronFormatError,
  isFreqType,
  nextRunAt,
  presetToCron,
  validateCron,
} from '../src/modules/schedules/cron.js';

describe('presetToCron', () => {
  it('daily / weekly / monthly 映射为标准 cron', () => {
    expect(presetToCron({ freqType: 'daily', time: '09:30' })).toBe('30 9 * * *');
    expect(presetToCron({ freqType: 'weekly', time: '08:00', weekday: 1 })).toBe('0 8 * * 1');
    expect(presetToCron({ freqType: 'monthly', time: '12:00', monthDay: 15 })).toBe('0 12 15 * *');
  });

  it('cron 类型原样返回并去除首尾空格', () => {
    expect(presetToCron({ freqType: 'cron', cronExpr: '  */5 * * * *  ' })).toBe('*/5 * * * *');
  });

  it('非法输入抛 CronFormatError', () => {
    expect(() => presetToCron({ freqType: 'daily', time: '9:30' })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'daily', time: '25:00' })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'weekly', time: '08:00', weekday: 9 })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'monthly', time: '08:00', monthDay: 0 })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'cron', cronExpr: '   ' })).toThrow(CronFormatError);
  });
});

describe('validateCron 与 nextRunAt', () => {
  it('isFreqType 仅接受四种取值', () => {
    expect(isFreqType('daily')).toBe(true);
    expect(isFreqType('cron')).toBe(true);
    expect(isFreqType('hourly')).toBe(false);
    expect(isFreqType(undefined)).toBe(false);
  });

  it('校验合法与非法表达式', () => {
    expect(validateCron('0 9 * * *', 'Asia/Shanghai')).toBe(true);
    expect(validateCron('not a cron', 'Asia/Shanghai')).toBe(false);
    expect(validateCron('', 'Asia/Shanghai')).toBe(false);
  });

  it('按指定时区计算下次触发时间', () => {
    // 2026-10-14T03:00:00Z = 北京时间 11:00，已过当日 09:00，故下次为次日 09:00（= 01:00Z）
    const ts = nextRunAt('0 9 * * *', 'Asia/Shanghai', Date.parse('2026-10-14T03:00:00Z'));
    expect(ts).not.toBeNull();
    expect(new Date(ts!).toISOString()).toBe('2026-10-15T01:00:00.000Z');
  });

  it('非法表达式返回 null', () => {
    expect(nextRunAt('bad expr', 'Asia/Shanghai')).toBeNull();
  });
});
