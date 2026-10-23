import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  EmptyHint,
  Field,
  Section,
  useInputCols,
  useNodeConfig,
  type PanelProps,
} from '@/components/panels/fields';
import type {
  CleansingConfig,
  ColumnMeta,
  FormulaConfig,
  FormulaDataType,
  FormulaItem,
  NullRemovalMode,
  SampleConfig,
  SampleMode,
  UniqueConfig,
} from '@/types';

const DATA_TYPES: { value: FormulaDataType; label: string }[] = [
  { value: 'VARCHAR', label: '字符串 V_String' },
  { value: 'BIGINT', label: '整数 Int64' },
  { value: 'DOUBLE', label: '浮点 Double' },
  { value: 'BOOLEAN', label: '布尔 Bool' },
  { value: 'DATE', label: '日期 Date' },
  { value: 'TIMESTAMP', label: '日期时间 DateTime' },
];

/** 行外壳：与其它列表型面板保持一致。 */
function RowShell({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-border p-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        title="删除"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

const NONE_ADD = '__add_column__';

/** 输出列选择：可从现有列中选，也可新增一列。 */
function OutputColumnPicker({
  value,
  onChange,
  columns,
}: {
  value: string;
  onChange: (value: string) => void;
  columns: ColumnMeta[];
}) {
  const [adding, setAdding] = useState(false);
  if (adding) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={columns.some((c) => c.name === value) ? '' : value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setAdding(false)}
          placeholder="新列名"
          className="h-8 text-xs"
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
          确定
        </Button>
      </div>
    );
  }
  const names = columns.map((c) => c.name);
  const isCustom = Boolean(value) && !names.includes(value);
  return (
    <Select
      value={value || ''}
      onValueChange={(next) => {
        if (next === NONE_ADD) setAdding(true);
        else onChange(next);
      }}
    >
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder="选择列或添加新列" />
      </SelectTrigger>
      <SelectContent>
        {isCustom && <SelectItem value={value}>{value}（新增）</SelectItem>}
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
        <SelectItem value={NONE_ADD}>+ 添加列…</SelectItem>
      </SelectContent>
    </Select>
  );
}

/* ----------------------------- Formula 公式 ----------------------------- */

export function FormulaPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<FormulaConfig>(node);
  const inCols = useInputCols(node.id);
  const formulas = config.formulas ?? [];

  const setFormulas = (next: FormulaItem[]) => patch({ formulas: next });
  const update = (index: number, p: Partial<FormulaItem>) =>
    setFormulas(formulas.map((item, i) => (i === index ? { ...item, ...p } : item)));
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= formulas.length) return;
    const copy = [...formulas];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    setFormulas(copy);
  };

  /** 每个表达式可引用：上游列 + 本节点中排在它前面的新建列。 */
  const columnsFor = (index: number): ColumnMeta[] => {
    const extra: ColumnMeta[] = formulas.slice(0, index)
      .filter((item) => item.field && item.field.trim().length > 0)
      .map((item) => ({ name: item.field.trim(), type: item.dataType }));
    const seen = new Set(inCols.map((c) => c.name));
    return [...inCols, ...extra.filter((c) => !seen.has(c.name))];
  };

  const appendColumn = (index: number, name: string) => {
    const current = formulas[index]?.expression ?? '';
    update(index, { expression: `${current}${current ? ' ' : ''}"${name}"` });
  };

  return (
    <Section
      title="表达式"
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            setFormulas([...formulas, { field: '', dataType: 'VARCHAR', expression: '' }])
          }
        >
          <Plus />
          添加
        </Button>
      }
    >
      {formulas.length === 0 ? (
        <EmptyHint>添加表达式，可覆盖现有列或新建列；按从上到下的顺序计算</EmptyHint>
      ) : (
        <div className="flex flex-col gap-2">
          {formulas.map((item, index) => (
            <RowShell key={index} onRemove={() => setFormulas(formulas.filter((_, i) => i !== index))}>
              <div className="text-[10px] font-medium text-muted-foreground">表达式 {index + 1}</div>
              <OutputColumnPicker
                value={item.field}
                onChange={(value) => update(index, { field: value })}
                columns={columnsFor(index)}
              />
              <div className="flex items-center gap-1.5">
                <Select
                  value={item.dataType ?? 'VARCHAR'}
                  onValueChange={(value) => update(index, { dataType: value as FormulaDataType })}
                >
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATA_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {item.dataType === 'VARCHAR' && (
                  <Input
                    type="number"
                    min={1}
                    value={item.size ?? ''}
                    onChange={(event) =>
                      update(index, {
                        size: event.target.value ? Number(event.target.value) : undefined,
                      })
                    }
                    placeholder="大小"
                    className="h-8 w-16 text-xs"
                  />
                )}
              </div>
              <Textarea
                value={item.expression}
                onChange={(event) => update(index, { expression: event.target.value })}
                placeholder='例如 amount * 1.1 或 CASE WHEN amount > 100 THEN 1 ELSE 0 END'
                spellCheck={false}
                className="min-h-[80px] font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1">
                {columnsFor(index).map((col) => (
                  <button
                    key={col.name}
                    type="button"
                    onClick={() => appendColumn(index, col.name)}
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {col.name}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-end gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  title="上移"
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === formulas.length - 1}
                  onClick={() => move(index, 1)}
                  title="下移"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </div>
            </RowShell>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ----------------------------- Unique 唯一值 ----------------------------- */

export function UniquePanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<UniqueConfig>(node);
  const inCols = useInputCols(node.id);
  const selected = config.fields ?? [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (name: string) => {
    const next = selectedSet.has(name)
      ? selected.filter((field) => field !== name)
      : [...selected, name];
    patch({ fields: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="唯一值字段"
        action={
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => patch({ fields: inCols.map((c) => c.name) })}
            >
              全选
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => patch({ fields: [] })}
            >
              取消全选
            </button>
          </div>
        }
      >
        {inCols.length === 0 ? (
          <EmptyHint>暂无可选列（请先连接上游节点并运行一次）</EmptyHint>
        ) : (
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
            {inCols.map((col) => (
              <label key={col.name} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedSet.has(col.name)}
                  onChange={() => toggle(col.name)}
                />
                <span className="truncate">{col.name}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{col.type}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          输出按唯一值字段排序。U 锚点输出每组首行，D 锚点输出每组中剩余的行。
        </p>
      </Section>
    </div>
  );
}

/* ----------------------------- Sample 样本 ----------------------------- */

const SAMPLE_MODES: { value: SampleMode; label: string }[] = [
  { value: 'first', label: '前 N 行' },
  { value: 'last', label: '后 N 行' },
  { value: 'skip', label: '跳过前 N 行' },
  { value: 'every', label: '每 N 行中的第一行' },
  { value: 'random', label: '每行有 N 分之一的机会被抽取' },
  { value: 'percent', label: '前百分之 N 行' },
];

export function SamplePanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<SampleConfig>(node);
  const inCols = useInputCols(node.id);
  const groupBy = config.groupBy ?? [];
  const groupSet = useMemo(() => new Set(groupBy), [groupBy]);

  const toggleGroup = (name: string) => {
    const next = groupSet.has(name) ? groupBy.filter((field) => field !== name) : [...groupBy, name];
    patch({ groupBy: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <Field label="抽样方式">
        <Select
          value={config.mode ?? 'first'}
          onValueChange={(value) => patch({ mode: value as SampleMode })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SAMPLE_MODES.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {mode.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label={config.mode === 'percent' ? 'N（百分比）' : 'N（行数）'}
        hint={
          config.mode === 'random'
            ? '随机抽样按概率判定每一行，实际行数会围绕总数 / N 波动。'
            : config.mode === 'percent'
              ? '按百分比取数需要先统计总行数，再按比例返回。'
              : undefined
        }
      >
        <Input
          type="number"
          min={1}
          value={config.n ?? 100}
          onChange={(event) => patch({ n: Number(event.target.value) })}
          className="h-8 text-xs"
        />
      </Field>

      <Section title="按列分组（可选）">
        {inCols.length === 0 ? (
          <EmptyHint>暂无可选列（请先连接上游节点并运行一次）</EmptyHint>
        ) : (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
            {inCols.map((col) => (
              <label key={col.name} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={groupSet.has(col.name)}
                  onChange={() => toggleGroup(col.name)}
                />
                <span className="truncate">{col.name}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          指定分组后每组各返回 N 行；不选则对整个数据流抽样。
        </p>
      </Section>
    </div>
  );
}

/* --------------------------- Data Cleansing 数据清理 --------------------------- */

const NULL_MODES: { value: NullRemovalMode; label: string }[] = [
  { value: 'any', label: '任一字段为 null 即移除' },
  { value: 'all', label: '所有字段都为 null 才移除' },
];

function NullOption({
  label,
  enabled,
  mode,
  onToggle,
  onModeChange,
}: {
  label: string;
  enabled: boolean;
  mode: NullRemovalMode;
  onToggle: (value: boolean) => void;
  onModeChange: (value: NullRemovalMode) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs">{label}</span>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>
      {enabled && (
        <Select value={mode} onValueChange={(value) => onModeChange(value as NullRemovalMode)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NULL_MODES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function CheckOption({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function CleansingPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<CleansingConfig>(node);
  const inCols = useInputCols(node.id);
  const selected = config.fields ?? [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleField = (name: string) => {
    const next = selectedSet.has(name)
      ? selected.filter((field) => field !== name)
      : [...selected, name];
    patch({ fields: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <Section title="移除 null 数据">
        <NullOption
          label="移除 null 行"
          enabled={config.removeNullRows === true}
          mode={config.nullRowMode ?? 'all'}
          onToggle={(value) => patch({ removeNullRows: value })}
          onModeChange={(value) => patch({ nullRowMode: value })}
        />
        <NullOption
          label="移除 null 列"
          enabled={config.removeNullColumns === true}
          mode={config.nullColumnMode ?? 'all'}
          onToggle={(value) => patch({ removeNullColumns: value })}
          onModeChange={(value) => patch({ nullColumnMode: value })}
        />
      </Section>

      <Section
        title="选择要清理的字段"
        action={
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => patch({ fields: inCols.map((c) => c.name) })}
            >
              全部
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => patch({ fields: [] })}
            >
              无
            </button>
          </div>
        }
      >
        {inCols.length === 0 ? (
          <EmptyHint>暂无可选列（请先连接上游节点并运行一次）</EmptyHint>
        ) : (
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
            {inCols.map((col) => (
              <label key={col.name} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedSet.has(col.name)}
                  onChange={() => toggleField(col.name)}
                />
                <span className="truncate">{col.name}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{col.type}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          不选表示对全部字段生效。除「替换为 0」外，字符类选项只作用于字符串字段。
        </p>
      </Section>

      <Section title="替换 null">
        <CheckOption
          label="替换为空白值（字符串字段）"
          checked={config.replaceNullString === true}
          onChange={(value) => patch({ replaceNullString: value })}
        />
        <CheckOption
          label="替换为 0（数值字段）"
          checked={config.replaceNullNumber === true}
          onChange={(value) => patch({ replaceNullNumber: value })}
        />
      </Section>

      <Section title="移除不需要的字符">
        <CheckOption
          label="前导和尾随空格"
          checked={config.trimWhitespace === true}
          onChange={(value) => patch({ trimWhitespace: value })}
        />
        <CheckOption
          label="制表符、换行符和重复空格（压缩为单个空格）"
          checked={config.reduceWhitespace === true}
          onChange={(value) => patch({ reduceWhitespace: value })}
        />
        <CheckOption
          label="所有空格"
          checked={config.removeAllWhitespace === true}
          onChange={(value) => patch({ removeAllWhitespace: value })}
        />
        <CheckOption
          label="字母"
          checked={config.removeLetters === true}
          onChange={(value) => patch({ removeLetters: value })}
        />
        <CheckOption
          label="数字"
          checked={config.removeNumbers === true}
          onChange={(value) => patch({ removeNumbers: value })}
        />
        <CheckOption
          label="标点符号"
          checked={config.removePunctuation === true}
          onChange={(value) => patch({ removePunctuation: value })}
        />
      </Section>

      <Section title="修改大小写">
        <Select
          value={config.caseMode ?? 'none'}
          onValueChange={(value) =>
            patch({ caseMode: value as CleansingConfig['caseMode'] })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">不修改</SelectItem>
            <SelectItem value="upper">大写</SelectItem>
            <SelectItem value="lower">小写</SelectItem>
            <SelectItem value="title">词首字母大写</SelectItem>
          </SelectContent>
        </Select>
      </Section>
    </div>
  );
}
