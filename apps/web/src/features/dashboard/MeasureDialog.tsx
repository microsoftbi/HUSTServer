import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@bi/components/ui/button';
import { Input } from '@bi/components/ui/input';
import { Label } from '@bi/components/ui/label';
import { Switch } from '@bi/components/ui/switch';
import { Textarea } from '@bi/components/ui/textarea';
import { ScrollArea } from '@bi/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@bi/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@bi/components/ui/select';
import { cn, uid } from '@bi/lib/utils';
import {
  DECIMAL_OPTIONS,
  DEFAULT_FIELD_FORMAT,
  UNIT_OPTIONS,
} from '@bi/lib/format';
import {
  TIME_COMPARE_LABELS,
  compileMeasure,
  measureSqlOf,
} from '@bi/lib/measure';
import { useDatasetStore } from '@bi/stores/datasetStore';
import type {
  Dataset,
  FieldFormat,
  NamedMeasure,
  TimeCompareKind,
} from '@bi/types';

interface MeasureDialogProps {
  dataset: Dataset;
  open: boolean;
  onClose: () => void;
}

const COMPARE_NONE = 'none';
const COMPARE_OPTIONS: Array<{ value: TimeCompareKind; label: string }> = (
  Object.keys(TIME_COMPARE_LABELS) as TimeCompareKind[]
).map((value) => ({ value, label: TIME_COMPARE_LABELS[value] }));

interface Draft {
  name: string;
  expression: string;
  format: FieldFormat;
  compare: TimeCompareKind | typeof COMPARE_NONE;
  compareField: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  expression: 'SUM([字段])',
  format: DEFAULT_FIELD_FORMAT,
  compare: COMPARE_NONE,
  compareField: '',
};

/**
 * 度量值管理（对齐 Power BI 的「新建度量值」）：
 * 表达式写一次即可在任意视觉对象中复用，并可翻译成 SQL 供数据源执行。
 */
export function MeasureDialog({ dataset, open, onClose }: MeasureDialogProps) {
  const updateDataset = useDatasetStore((s) => s.updateDataset);
  const measures = useMemo(() => dataset.measures ?? {}, [dataset.measures]);
  const list = useMemo(() => Object.values(measures), [measures]);
  const [selected, setSelected] = useState<string | 'new'>('new');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const dateColumns = useMemo(
    () => dataset.columns.filter((c) => c.type === 'date').map((c) => c.name),
    [dataset.columns],
  );

  useEffect(() => {
    if (!open) return;
    setSelected(list.length > 0 ? list[0].id : 'new');
  }, [open, dataset.id]);

  useEffect(() => {
    if (!open || selected === 'new') {
      if (selected === 'new') setDraft(EMPTY_DRAFT);
      return;
    }
    const def = measures[selected];
    if (!def) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    setDraft({
      name: def.name,
      expression: def.expression,
      format: def.format ?? DEFAULT_FIELD_FORMAT,
      compare: def.timeCompare?.kind ?? COMPARE_NONE,
      compareField: def.timeCompare?.field ?? '',
    });
  }, [open, selected, measures]);

  const compiled = useMemo(
    () => compileMeasure({ id: selected, name: draft.name, expression: draft.expression }),
    [selected, draft.name, draft.expression],
  );

  const sql = useMemo(
    () =>
      measureSqlOf(
        { id: selected, name: draft.name || '度量', expression: draft.expression },
        measures,
      ),
    [selected, draft.name, draft.expression, measures],
  );

  const nameError = useMemo(() => {
    const name = draft.name.trim();
    if (!name) return '请填写度量名称';
    if (dataset.columns.some((c) => c.name === name)) return '名称与字段重复';
    const dup = list.some((m) => m.id !== selected && m.name === name);
    if (dup) return '名称已被其它度量使用';
    return null;
  }, [draft.name, dataset.columns, list, selected]);

  const error = nameError ?? compiled.error ?? null;
  const canSave = !error && draft.expression.trim().length > 0;

  function patch(next: Partial<Draft>) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  function save() {
    if (!canSave) return;
    const id = selected === 'new' ? uid() : selected;
    const def: NamedMeasure = {
      id,
      name: draft.name.trim(),
      expression: draft.expression.trim(),
      ...(draft.format.percent || draft.format.decimals >= 0 || draft.format.unit !== 'none'
        ? { format: draft.format }
        : {}),
      ...(draft.compare !== COMPARE_NONE
        ? {
            timeCompare: {
              kind: draft.compare,
              ...(draft.compareField ? { field: draft.compareField } : {}),
            },
          }
        : {}),
    };
    updateDataset(dataset.id, { measures: { ...measures, [id]: def } });
    setSelected(id);
  }

  function remove() {
    if (selected === 'new') return;
    const next = { ...measures };
    delete next[selected];
    updateDataset(dataset.id, { measures: Object.keys(next).length > 0 ? next : undefined });
    setSelected('new');
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>度量值 · {dataset.name}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-4">
          <aside className="w-48 shrink-0 space-y-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full justify-start gap-1.5 text-xs"
              onClick={() => setSelected('new')}
            >
              <Plus className="h-3.5 w-3.5" />
              新建度量
            </Button>
            <ScrollArea className="h-72 rounded-md border">
              <ul className="space-y-0.5 p-1">
                {list.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(m.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                        m.id === selected && 'bg-accent font-medium',
                      )}
                    >
                      <span className="flex-1 truncate">{m.name}</span>
                      {m.timeCompare ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {TIME_COMPARE_LABELS[m.timeCompare.kind]}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
                {list.length === 0 ? (
                  <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    还没有度量值
                  </li>
                ) : null}
              </ul>
            </ScrollArea>
          </aside>

          <section className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="measure-name" className="text-xs">
                名称
              </Label>
              <Input
                id="measure-name"
                value={draft.name}
                placeholder="例如：本月销售额、销售毛利率"
                onChange={(e) => patch({ name: e.target.value })}
                className="h-8 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="measure-expr" className="text-xs">
                表达式
              </Label>
              <Textarea
                id="measure-expr"
                value={draft.expression}
                onChange={(e) => patch({ expression: e.target.value })}
                rows={3}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="SUM([销售额]) / NULLIF(SUM([订单数]), 0)"
              />
              <p className="text-[11px] text-muted-foreground">
                支持 SUM / AVG / MIN / MAX / COUNT([字段])、[其它度量名]、+ - * / 、括号与
                divide(a, b)。
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">小数位</Label>
                <Select
                  value={String(draft.format.decimals)}
                  onValueChange={(v) => patch({ format: { ...draft.format, decimals: Number(v) } })}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DECIMAL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">显示单位</Label>
                <Select
                  value={draft.format.unit}
                  onValueChange={(v) =>
                    patch({ format: { ...draft.format, unit: v as FieldFormat['unit'] } })
                  }
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNIT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">时间对比</Label>
                <Select
                  value={draft.compare}
                  onValueChange={(v) => patch({ compare: v as Draft['compare'] })}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={COMPARE_NONE}>不启用</SelectItem>
                    {COMPARE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="measure-percent"
                  checked={!!draft.format.percent}
                  onCheckedChange={(v) => patch({ format: { ...draft.format, percent: v } })}
                />
                <Label htmlFor="measure-percent" className="text-xs">
                  按百分比显示
                </Label>
              </div>
              {draft.compare !== COMPARE_NONE ? (
                <Select
                  value={draft.compareField || '__auto__'}
                  onValueChange={(v) =>
                    patch({ compareField: v === '__auto__' ? '' : v })
                  }
                >
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue placeholder="日期字段" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__" className="text-xs">
                      自动（使用日期维度）
                    </SelectItem>
                    {dateColumns.map((f) => (
                      <SelectItem key={f} value={f} className="text-xs">
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">SQL 预览</Label>
              <pre className="max-h-24 overflow-auto rounded-md border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {sql.sql ?? `-- ${sql.error ?? '无法翻译'}`}
              </pre>
            </div>

            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {draft.compare !== COMPARE_NONE
                  ? `启用${TIME_COMPARE_LABELS[draft.compare]}时，图表会按日期维度追加一列对比值。`
                  : `依赖 ${compiled.fields.length} 个字段、${compiled.refs.length} 个度量。`}
              </p>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-destructive"
                disabled={selected === 'new'}
                onClick={remove}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onClose}>
                  关闭
                </Button>
                <Button size="sm" className="h-7 text-xs" disabled={!canSave} onClick={save}>
                  保存度量
                </Button>
              </div>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
