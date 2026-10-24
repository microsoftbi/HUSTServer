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
import { Switch } from '@/components/ui/switch';
import {
  ColumnSelect,
  Field,
  Section,
  useInputCols,
  useNodeConfig,
  type PanelProps,
} from '@/components/panels/fields';
import type {
  FindReplaceConfig,
  FindReplaceMode,
  TextInputConfig,
  TextInputField,
  TextInputFieldType,
} from '@/types';

const FIELD_TYPES: TextInputFieldType[] = [
  'VARCHAR',
  'BIGINT',
  'DOUBLE',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
];

/* --------------------------- Text Input 手工输入 --------------------------- */

/** Text Input：维护字段定义与数据行，对齐 Alteryx 的 Text Input。 */
export function TextInputPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<TextInputConfig>(node);
  const fields = config.fields ?? [];
  const rows = config.rows ?? [];

  /** 字段数量变化时同步补齐/裁剪每行单元格。 */
  function setFields(next: TextInputField[]) {
    patch({
      fields: next,
      rows: rows.map((row) => next.map((_, index) => String(row?.[index] ?? ''))),
    });
  }

  function patchField(index: number, p: Partial<TextInputField>) {
    setFields(fields.map((field, i) => (i === index ? { ...field, ...p } : field)));
  }

  function removeField(index: number) {
    setFields(fields.filter((_, i) => i !== index));
  }

  function setCell(rowIndex: number, colIndex: number, value: string) {
    patch({
      rows: rows.map((row, i) => {
        if (i !== rowIndex) return row;
        const next = fields.map((_, c) => String(row?.[c] ?? ''));
        next[colIndex] = value;
        return next;
      }),
    });
  }

  function addRow() {
    patch({ rows: [...rows, fields.map(() => '')] });
  }

  function removeRow(index: number) {
    patch({ rows: rows.filter((_, i) => i !== index) });
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="字段"
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="添加字段"
            onClick={() => setFields([...fields, { name: `Field${fields.length + 1}`, type: 'VARCHAR' }])}
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {fields.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">尚未定义字段，点击右上角「+」添加。</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {fields.map((field, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={field.name}
                  onChange={(e) => patchField(index, { name: e.target.value })}
                  placeholder="字段名"
                  className="h-8 flex-1 text-xs"
                />
                <Select
                  value={field.type ?? 'VARCHAR'}
                  onValueChange={(value) =>
                    patchField(index, { type: value as TextInputFieldType })
                  }
                >
                  <SelectTrigger className="h-8 w-[104px] shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="删除字段"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeField(index)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={`数据（${rows.length} 行）`}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            disabled={fields.length === 0}
            onClick={addRow}
          >
            <Plus className="size-3" />
            添加行
          </Button>
        }
      >
        {rows.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">暂无数据行，点击「添加行」录入。</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <div
              className="min-w-max"
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${fields.length}, minmax(96px, 1fr)) 28px`,
              }}
            >
              {fields.map((field, index) => (
                <div
                  key={`h${index}`}
                  className="truncate border-b border-r border-border bg-muted/40 px-1.5 py-1 text-[10px] font-medium text-muted-foreground"
                  title={field.name}
                >
                  {field.name || `Field${index + 1}`}
                </div>
              ))}
              <div key="h-end" className="border-b border-border bg-muted/40" />
              {rows.map((row, rowIndex) => (
                <div key={`r${rowIndex}`} className="contents">
                  {fields.map((_, colIndex) => (
                    <div key={`c${rowIndex}-${colIndex}`} className="border-b border-r border-border">
                      <Input
                        value={String(row?.[colIndex] ?? '')}
                        onChange={(e) => setCell(rowIndex, colIndex, e.target.value)}
                        className="h-7 rounded-none border-0 px-1.5 text-xs shadow-none focus-visible:ring-0"
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-center border-b border-border">
                    <button
                      type="button"
                      title="删除行"
                      className="text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => removeRow(rowIndex)}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          空单元格在非字符串类型上按 NULL 写入；字符串类型按空字符串写入。
        </p>
      </Section>
    </div>
  );
}

/* ----------------------------- Find Replace ----------------------------- */

const MODE_OPTIONS: Array<{ value: FindReplaceMode; label: string }> = [
  { value: 'replace', label: '替换原字段' },
  { value: 'append', label: '追加为新字段' },
];

/** Find Replace：用查找表（R）替换数据表（F）中的字段值。 */
export function FindReplacePanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<FindReplaceConfig>(node);
  const dataCols = useInputCols(node.id, 'in');
  const lookupCols = useInputCols(node.id, 'lookup');
  const mode: FindReplaceMode = config.mode === 'append' ? 'append' : 'replace';
  const field = config.field ?? '';

  return (
    <div className="flex flex-col gap-4">
      <Field label="查找字段（F 输入）" hint="数据表中参与匹配的字段，匹配值转为文本比较。">
        <ColumnSelect
          value={field}
          onChange={(value) => patch({ field: value })}
          columns={dataCols}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="查找值字段（R 输入）">
          <ColumnSelect
            value={config.findField ?? ''}
            onChange={(value) => patch({ findField: value })}
            columns={lookupCols}
            placeholder="默认 Find"
          />
        </Field>
        <Field label="替换值字段（R 输入）">
          <ColumnSelect
            value={config.replaceField ?? ''}
            onChange={(value) => patch({ replaceField: value })}
            columns={lookupCols}
            placeholder="默认 Replace"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="输出方式">
          <Select
            value={mode}
            onValueChange={(value) => patch({ mode: value as FindReplaceMode })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {mode === 'append' && (
          <Field label="新字段名" hint={`留空则为 ${field || '<字段>'}_Replaced`}>
            <Input
              value={config.newField ?? ''}
              onChange={(e) => patch({ newField: e.target.value })}
              placeholder={`${field || '字段'}_Replaced`}
              className="h-8 text-xs"
            />
          </Field>
        )}
      </div>

      <Field label="区分大小写">
        <div className="flex items-center gap-2">
          <Switch
            checked={config.matchCase !== false}
            onCheckedChange={(checked) => patch({ matchCase: checked })}
          />
          <span className="text-[11px] text-muted-foreground">
            {config.matchCase !== false ? '区分大小写' : '忽略大小写'}
          </span>
        </div>
      </Field>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        F 端口接数据表，R 端口接查找表；重复的查找值取第一条替换值，未匹配的行保留原值。
      </p>
    </div>
  );
}
