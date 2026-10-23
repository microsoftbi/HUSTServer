import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
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
import { useDesignerHost } from '@/context';
import { Field, Section, useNodeConfig, type PanelProps } from '@/components/panels/fields';
import { SqlConnectionPicker } from '@/components/panels/SqlConnectionPicker';
import type {
  DataModelDuplicateMode,
  DataModelOutputConfig,
  OutputCsvConfig,
  OutputExcelConfig,
  OutputSqlServerConfig,
  SqlObjectRef,
} from '@/types';

/** 目标表建议列表的 datalist id（同一时刻只渲染一个面板，固定 id 即可）。 */
const TARGET_TABLE_LIST_ID = 'output-sql-target-tables';

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

/* ----------------------------- Data Model 输出 ----------------------------- */

export function OutputDataModelPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<DataModelOutputConfig>(node);
  const modelName = (config.modelName ?? '').trim();
  const invalid = modelName.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(modelName);

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="数据模型名称"
        hint="写入后可在「数据模型」页查看，也可作为仪表板的数据集。"
      >
        <Input
          value={config.modelName ?? ''}
          onChange={(event) => patch({ modelName: event.target.value })}
          placeholder="例如 sales_summary"
          className="h-8 text-xs"
        />
        {invalid && (
          <p className="text-xs text-destructive">
            需以字母或下划线开头，只能包含字母、数字、下划线，最长 64 位
          </p>
        )}
      </Field>

      <Field
        label="同名模型已存在时"
        hint="工作流每次运行都会写入；定时调度时建议明确选择行为。"
      >
        <Select
          value={config.onDuplicate ?? 'overwrite'}
          onValueChange={(value) => patch({ onDuplicate: value as DataModelDuplicateMode })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="overwrite">覆盖已有模型</SelectItem>
            <SelectItem value="error">停止并报错</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        选择「停止并报错」时，同名模型已存在会让本次运行在此节点失败，已有模型保持原样。
      </p>
    </div>
  );
}

/* ----------------------------- SQL Server 输出 ----------------------------- */

export function OutputSqlServerPanel({ node }: PanelProps) {
  const { adapter } = useDesignerHost();
  const [config, patch] = useNodeConfig<OutputSqlServerConfig>(node);
  const [objects, setObjects] = useState<SqlObjectRef[]>([]);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [objectError, setObjectError] = useState<string | null>(null);
  const connectionId = config.connectionId ?? '';

  const loadObjects = useCallback(async (id: string) => {
    if (!id || !adapter.listSqlObjectsByConnection) {
      setObjects([]);
      setObjectError(null);
      return;
    }
    setLoadingObjects(true);
    setObjectError(null);
    try {
      const refs = await adapter.listSqlObjectsByConnection(id);
      setObjects(refs);
    } catch (err) {
      setObjects([]);
      setObjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingObjects(false);
    }
  }, [adapter]);

  useEffect(() => {
    void loadObjects(connectionId);
  }, [connectionId, loadObjects]);

  return (
    <div className="flex flex-col gap-4">
      <SqlConnectionPicker
        value={connectionId}
        legacyEmbedded={Boolean(config.connection)}
        onChange={(nextId) => patch({ connectionId: nextId })}
      />

      <Section title="写入设置">
        <Field
          label="目标表"
          hint="可从下拉选择连接下的已有表 / 视图，也可直接输入新表名（配合「表不存在时自动创建」）。"
        >
          <div className="flex items-center gap-1.5">
            <Input
              list={TARGET_TABLE_LIST_ID}
              value={config.table ?? ''}
              onChange={(event) => patch({ table: event.target.value })}
              placeholder="dbo.TargetTable"
              className="h-8 text-xs"
            />
            <datalist id={TARGET_TABLE_LIST_ID}>
              {objects.map((obj) => {
                const value = `${obj.schema}.${obj.name}`;
                return <option key={value} value={value} />;
              })}
            </datalist>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title="刷新表 / 视图列表"
              disabled={loadingObjects || !connectionId}
              onClick={() => void loadObjects(connectionId)}
            >
              {loadingObjects ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </div>
        </Field>
        {objectError && <p className="text-xs text-destructive">{objectError}</p>}

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
