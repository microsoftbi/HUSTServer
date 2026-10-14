import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Field, Section, useNodeConfig, type PanelProps } from '@/components/panels/fields';
import { SqlConnectionForm } from '@/components/panels/SqlConnectionForm';
import type { OutputCsvConfig, OutputExcelConfig, OutputSqlServerConfig } from '@/types';

/* ----------------------------- CSV 输出 ----------------------------- */

export function OutputCsvPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<OutputCsvConfig>(node);
  return (
    <div className="flex flex-col gap-4">
      <Field label="输出文件" hint="相对路径将写入后端输出目录；也可填写绝对路径。">
        <Input
          value={config.path ?? ''}
          onChange={(event) => patch({ path: event.target.value })}
          placeholder="output.csv"
          className="h-8 text-xs"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="分隔符">
          <Select
            value={config.delimiter ?? ','}
            onValueChange={(value) => patch({ delimiter: value })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value=",">逗号 ,</SelectItem>
              <SelectItem value={'\t'}>制表符 Tab</SelectItem>
              <SelectItem value=";">分号 ;</SelectItem>
              <SelectItem value="|">竖线 |</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="表头">
          <label className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={config.hasHeader ?? true}
              onCheckedChange={(checked) => patch({ hasHeader: checked })}
            />
            写出表头行
          </label>
        </Field>
      </div>
    </div>
  );
}

/* ----------------------------- Excel 输出 ----------------------------- */

export function OutputExcelPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<OutputExcelConfig>(node);
  return (
    <div className="flex flex-col gap-4">
      <Field label="输出文件" hint="相对路径将写入后端输出目录；也可填写绝对路径。">
        <Input
          value={config.path ?? ''}
          onChange={(event) => patch({ path: event.target.value })}
          placeholder="output.xlsx"
          className="h-8 text-xs"
        />
      </Field>
      <Field label="工作表名称">
        <Input
          value={config.sheet ?? ''}
          onChange={(event) => patch({ sheet: event.target.value })}
          placeholder="Sheet1"
          className="h-8 text-xs"
        />
      </Field>
    </div>
  );
}

/* ----------------------------- SQL Server 输出 ----------------------------- */

export function OutputSqlServerPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<OutputSqlServerConfig>(node);
  return (
    <div className="flex flex-col gap-4">
      <SqlConnectionForm
        connection={config.connection}
        onChange={(connection) => patch({ connection })}
      />

      <Section title="写入设置">
        <Field label="目标表">
          <Input
            value={config.table ?? ''}
            onChange={(event) => patch({ table: event.target.value })}
            placeholder="dbo.TargetTable"
            className="h-8 text-xs"
          />
        </Field>

        <Field label="写入模式">
          <Select
            value={config.mode ?? 'append'}
            onValueChange={(value) => patch({ mode: value as 'append' | 'overwrite' })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="append">追加 Append</SelectItem>
              <SelectItem value="overwrite">覆盖 Overwrite</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <label className="flex items-center justify-between rounded-md border border-border p-2.5 text-xs text-muted-foreground">
          表不存在时自动创建
          <Switch
            checked={config.createTable ?? true}
            onCheckedChange={(checked) => patch({ createTable: checked })}
          />
        </label>
      </Section>
    </div>
  );
}
