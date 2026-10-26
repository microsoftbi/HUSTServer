import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { useJobEditorStore } from './store/jobEditorStore.js';
import type { ScheduleForm } from './lib/api.js';

const FREQ_OPTIONS: Array<{ value: ScheduleForm['freqType']; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'cron', label: '自定义 cron' },
];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Job 级设置：名称、描述与定时调度，统一在顶部「Job 设置」弹窗中编辑。 */
export function JobSettingsDialog({
  open,
  onClose,
  locked = false,
}: {
  open: boolean;
  onClose: () => void;
  locked?: boolean;
}) {
  const name = useJobEditorStore((s) => s.name);
  const description = useJobEditorStore((s) => s.description);
  const schedule = useJobEditorStore((s) => s.schedule);
  const setJobMeta = useJobEditorStore((s) => s.setJobMeta);

  const [draftName, setDraftName] = useState(name);
  const [draftDescription, setDraftDescription] = useState(description);
  const [draftSchedule, setDraftSchedule] = useState<ScheduleForm>(schedule);

  // 每次打开时从 store 取最新值，取消即丢弃草稿。
  useEffect(() => {
    if (!open) return;
    setDraftName(name);
    setDraftDescription(description);
    setDraftSchedule(schedule);
  }, [open, name, description, schedule]);

  const patchSchedule = (patch: Partial<ScheduleForm>) =>
    setDraftSchedule((prev) => ({ ...prev, ...patch }));

  const valid = draftName.trim().length > 0;

  function confirm(): void {
    if (!valid) return;
    setJobMeta({ name: draftName.trim(), description: draftDescription, schedule: draftSchedule });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Job 设置"
      className="max-w-lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={confirm} disabled={!valid || locked}>确定</Button>
        </>
      }
    >
      {locked && (
        <p className="rounded-md border border-border bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
          当前正在保存或运行，暂不可修改。
        </p>
      )}

      <Field label="名称（必填）" hint="显示在 Job 列表与运行记录中。">
        <Input
          value={draftName}
          disabled={locked}
          autoFocus
          onChange={(event) => setDraftName(event.target.value)}
        />
      </Field>

      <Field label="描述">
        <Textarea
          className="min-h-16"
          value={draftDescription}
          disabled={locked}
          onChange={(event) => setDraftDescription(event.target.value)}
        />
      </Field>

      <div className="space-y-3 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draftSchedule.enabled}
            disabled={locked}
            onChange={(event) => patchSchedule({ enabled: event.target.checked })}
          />
          启用定时调度
        </label>
        {draftSchedule.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="频次">
              <Select
                value={draftSchedule.freqType}
                disabled={locked}
                onChange={(event) => patchSchedule({ freqType: event.target.value as ScheduleForm['freqType'] })}
              >
                {FREQ_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </Field>
            {draftSchedule.freqType !== 'cron' && (
              <Field label="时间">
                <Input
                  type="time"
                  value={draftSchedule.time}
                  disabled={locked}
                  onChange={(event) => patchSchedule({ time: event.target.value })}
                />
              </Field>
            )}
            {draftSchedule.freqType === 'weekly' && (
              <Field label="星期">
                <Select
                  value={draftSchedule.weekday}
                  disabled={locked}
                  onChange={(event) => patchSchedule({ weekday: Number(event.target.value) })}
                >
                  {WEEKDAYS.map((label, index) => (
                    <option key={index} value={index}>{label}</option>
                  ))}
                </Select>
              </Field>
            )}
            {draftSchedule.freqType === 'monthly' && (
              <Field label="日期（1-31）">
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={draftSchedule.monthDay}
                  disabled={locked}
                  onChange={(event) => patchSchedule({ monthDay: Number(event.target.value) })}
                />
              </Field>
            )}
            {draftSchedule.freqType === 'cron' && (
              <Field label="cron 表达式（5 段）">
                <Input
                  className="font-mono"
                  value={draftSchedule.cronExpr}
                  disabled={locked}
                  onChange={(event) => patchSchedule({ cronExpr: event.target.value })}
                />
              </Field>
            )}
            <Field label="时区">
              <Input
                value={draftSchedule.timezone}
                disabled={locked}
                onChange={(event) => patchSchedule({ timezone: event.target.value })}
              />
            </Field>
          </div>
        )}
        {draftSchedule.enabled && draftSchedule.freqType === 'cron' && !draftSchedule.cronExpr.trim() && (
          <p className="text-xs text-destructive">请填写 cron 表达式</p>
        )}
      </div>
    </Modal>
  );
}
