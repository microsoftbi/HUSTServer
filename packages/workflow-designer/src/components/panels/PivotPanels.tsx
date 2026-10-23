import { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ColumnSelect,
  EmptyHint,
  Field,
  Section,
  useInputCols,
  useNodeConfig,
  type PanelProps,
} from '@/components/panels/fields';
import type {
  ColumnMeta,
  CrossTabConfig,
  CrossTabMethod,
  RunningTotalConfig,
  TextToColumnsConfig,
  TransposeConfig,
} from '@/types';
import { cn } from '@/lib/utils';

const NUMBER_TYPE = /INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL/i;

/** 多选字段列表：复用各面板的分组 / 键字段选择。 */
function FieldChecklist({
  columns,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  className,
}: {
  columns: ColumnMeta[];
  selected: string[];
  onToggle: (name: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  className?: string;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  if (columns.length === 0) {
    return <EmptyHint>暂无可选列（请先连接上游节点）</EmptyHint>;
  }
  return (
    <div className={cn('flex flex-col gap-1 rounded-md border border-border p-2', className)}>
      <div className="flex items-center gap-2 pb-1 text-[11px]">
        <button type="button" className="text-primary hover:underline" onClick={onSelectAll}>
          全选
        </button>
        <button type="button" className="text-muted-foreground hover:underline" onClick={onClear}>
          取消全选
        </button>
      </div>
      {columns.map((col) => (
        <label key={col.name} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={selectedSet.has(col.name)}
            onChange={() => onToggle(col.name)}
          />
          <span className="truncate">{col.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{col.type}</span>
        </label>
      ))}
    </div>
  );
}

/* --------------------------- Running Total 累计 --------------------------- */

export function RunningTotalPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<RunningTotalConfig>(node);
  const inCols = useInputCols(node.id);
  const numericCols = useMemo(
    () => inCols.filter((col) => NUMBER_TYPE.test(col.type)),
    [inCols],
  );
  const groupBy = config.groupBy ?? [];
  const items = config.items ?? [];

  const toggleGroup = (name: string) => {
    patch({
      groupBy: groupBy.includes(name)
        ? groupBy.filter((field) => field !== name)
        : [...groupBy, name],
    });
  };
  const setItems = (next: RunningTotalConfig['items']) => patch({ items: next });

  return (
    <div className="flex flex-col gap-4">
      <Section title="累计字段">
        {items.length === 0 ? (
          <EmptyHint>添加需要累计的数值字段</EmptyHint>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item, index) => (
              <div
                key={index}
                className="flex flex-col gap-1.5 rounded-md border border-border p-2"
              >
                <div className="flex items-center gap-1.5">
                  <ColumnSelect
                    value={item.field}
                    onChange={(value) =>
                      setItems(items.map((it, i) => (i === index ? { ...it, field: value } : it)))
                    }
                    columns={numericCols}
                    placeholder="选择数值字段"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setItems(items.filter((_, i) => i !== index))}
                    title="删除"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={item.replaceExisting === true}
                    onChange={(event) =>
                      setItems(
                        items.map((it, i) =>
                          i === index ? { ...it, replaceExisting: event.target.checked } : it,
                        ),
                      )
                    }
                  />
                  覆盖原列（否则新增一列）
                </label>
                {!item.replaceExisting && (
                  <Input
                    value={item.outputName ?? ''}
                    onChange={(event) =>
                      setItems(
                        items.map((it, i) =>
                          i === index ? { ...it, outputName: event.target.value } : it,
                        ),
                      )
                    }
                    placeholder={`默认 RunningTotal_${item.field || '字段'}`}
                    className="h-8 text-xs"
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setItems([...items, { field: '' }])}
        >
          <Plus />
          添加字段
        </Button>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          按记录进入节点的顺序累加。需要固定顺序时，先接一个 Sort 节点。
        </p>
      </Section>

      <Section title="分组字段（可选）">
        <FieldChecklist
          columns={inCols}
          selected={groupBy}
          onToggle={toggleGroup}
          onSelectAll={() => patch({ groupBy: inCols.map((col) => col.name) })}
          onClear={() => patch({ groupBy: [] })}
          className="max-h-52 overflow-y-auto"
        />
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          指定分组后，每个分组内单独累计，对应 Alteryx 的 Group By。
        </p>
      </Section>
    </div>
  );
}

/* --------------------------- Text to Columns 分列 --------------------------- */

const DELIMITER_PRESETS: { value: string; label: string }[] = [
  { value: ',', label: '逗号 ,' },
  { value: '\t', label: '制表符 Tab' },
  { value: ';', label: '分号 ;' },
  { value: '|', label: '竖线 |' },
  { value: ' ', label: '空格' },
  { value: '\n', label: '换行符' },
];

const CUSTOM_DELIMITER = '__custom__';

export function TextToColumnsPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<TextToColumnsConfig>(node);
  const inCols = useInputCols(node.id);
  const delimiter = config.delimiter ?? ',';
  const isPreset = DELIMITER_PRESETS.some((preset) => preset.value === delimiter);

  return (
    <div className="flex flex-col gap-4">
      <Field label="要拆分的字段">
        <ColumnSelect
          value={config.field ?? ''}
          onChange={(value) => patch({ field: value })}
          columns={inCols}
          placeholder="选择字段"
        />
      </Field>

      <Field label="分隔符">
        <Select
          value={isPreset ? delimiter : CUSTOM_DELIMITER}
          onValueChange={(value) =>
            patch({ delimiter: value === CUSTOM_DELIMITER ? ' ' : value })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DELIMITER_PRESETS.map((preset) => (
              <SelectItem key={preset.label} value={preset.value}>
                {preset.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_DELIMITER}>自定义…</SelectItem>
          </SelectContent>
        </Select>
        {!isPreset && (
          <Input
            value={delimiter}
            onChange={(event) => patch({ delimiter: event.target.value })}
            placeholder="自定义分隔符，支持多字符"
            className="h-8 text-xs"
          />
        )}
      </Field>

      <Field label="输出方式">
        <div className="flex items-center gap-1">
          {[
            { value: 'columns', label: '拆分为列' },
            { value: 'rows', label: '拆分为行' },
          ].map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={config.mode === option.value ? 'secondary' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => patch({ mode: option.value as TextToColumnsConfig['mode'] })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </Field>

      {config.mode !== 'rows' && (
        <Field label="拆分后的根名称" hint="新列按 <根名称>1、<根名称>2… 命名；留空则沿用原字段名。">
          <Input
            value={config.rootName ?? ''}
            onChange={(event) => patch({ rootName: event.target.value })}
            placeholder={config.field || '默认与原字段同名'}
            className="h-8 text-xs"
          />
        </Field>
      )}

      {config.mode !== 'rows' && (
        <Field label="列数" hint="0 表示自动按实际最大分段数生成列。">
          <Input
            type="number"
            min={0}
            value={config.maxColumns ?? 0}
            onChange={(event) => patch({ maxColumns: Number(event.target.value) })}
            className="h-8 text-xs"
          />
        </Field>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={config.skipEmpty === true}
          onChange={(event) => patch({ skipEmpty: event.target.checked })}
        />
        忽略空分段（连续分隔符不产生空值）
      </label>
    </div>
  );
}

/* ------------------------------- Cross Tab 交叉表 ------------------------------- */

const CROSS_TAB_METHODS: { value: CrossTabMethod; label: string }[] = [
  { value: 'first', label: 'First（首条记录）' },
  { value: 'last', label: 'Last（末条记录）' },
  { value: 'sum', label: 'Sum（求和）' },
  { value: 'count', label: 'Count（计数）' },
  { value: 'min', label: 'Minimum（最小值）' },
  { value: 'max', label: 'Maximum（最大值）' },
  { value: 'concat', label: 'Concatenate（拼接文本）' },
];

export function CrossTabPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<CrossTabConfig>(node);
  const inCols = useInputCols(node.id);
  const groupBy = config.groupBy ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Field label="表头字段" hint="该字段的不同取值会变成输出中的新列。">
        <ColumnSelect
          value={config.headerField ?? ''}
          onChange={(value) => patch({ headerField: value })}
          columns={inCols}
          placeholder="选择字段"
        />
      </Field>

      <Field label="值字段" hint="填入交叉单元格的取值。">
        <ColumnSelect
          value={config.valueField ?? ''}
          onChange={(value) => patch({ valueField: value })}
          columns={inCols}
          placeholder="选择字段"
        />
      </Field>

      <Field label="取值方法" hint="同一单元格出现多条记录时按此方式合并。">
        <Select
          value={config.method ?? 'first'}
          onValueChange={(value) => patch({ method: value as CrossTabMethod })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CROSS_TAB_METHODS.map((method) => (
              <SelectItem key={method.value} value={method.value}>
                {method.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="列名前缀（可选）">
        <Input
          value={config.prefix ?? ''}
          onChange={(event) => patch({ prefix: event.target.value })}
          placeholder="例如 sales_"
          className="h-8 text-xs"
        />
      </Field>

      <Section title="分组字段（可选）">
        <FieldChecklist
          columns={inCols}
          selected={groupBy}
          onToggle={(name) =>
            patch({
              groupBy: groupBy.includes(name)
                ? groupBy.filter((field) => field !== name)
                : [...groupBy, name],
            })
          }
          onSelectAll={() => patch({ groupBy: inCols.map((col) => col.name) })}
          onClear={() => patch({ groupBy: [] })}
          className="max-h-52 overflow-y-auto"
        />
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          不选分组字段时，整张表汇成一行。
        </p>
      </Section>
    </div>
  );
}

/* ------------------------------- Transpose 行列互转 ------------------------------- */

export function TransposePanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<TransposeConfig>(node);
  const inCols = useInputCols(node.id);
  const keyFields = config.keyFields ?? [];
  const dataFields = config.dataFields ?? [];

  const toggle = (list: string[], name: string): string[] =>
    list.includes(name) ? list.filter((field) => field !== name) : [...list, name];

  return (
    <div className="flex flex-col gap-4">
      <Section title="数据字段" action={<span className="text-[10px] text-muted-foreground">转成行</span>}>
        <FieldChecklist
          columns={inCols}
          selected={dataFields}
          onToggle={(name) => patch({ dataFields: toggle(dataFields, name) })}
          onSelectAll={() => patch({ dataFields: inCols.map((col) => col.name) })}
          onClear={() => patch({ dataFields: [] })}
          className="max-h-52 overflow-y-auto"
        />
      </Section>

      <Section title="键字段（可选）" action={<span className="text-[10px] text-muted-foreground">保持不变</span>}>
        <FieldChecklist
          columns={inCols}
          selected={keyFields}
          onToggle={(name) => patch({ keyFields: toggle(keyFields, name) })}
          onSelectAll={() => patch({ keyFields: inCols.map((col) => col.name) })}
          onClear={() => patch({ keyFields: [] })}
          className="max-h-52 overflow-y-auto"
        />
      </Section>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        输出为「键字段 + Name + Value」：Name 存放原列名，Value 存放取值。多个数据字段类型不一致时，Value 统一为字符串。
      </p>
    </div>
  );
}
