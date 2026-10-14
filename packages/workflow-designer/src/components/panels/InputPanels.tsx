import { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, RefreshCw } from 'lucide-react';
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
import { useDesignerHost } from '@/context';
import { Field, useNodeConfig, type PanelProps } from '@/components/panels/fields';
import { FilePathField } from '@/components/panels/FilePicker';
import { SqlConnectionForm } from '@/components/panels/SqlConnectionForm';
import type {
  FileUploadResult,
  InputCsvConfig,
  InputExcelConfig,
  InputSqlServerConfig,
  SqlObjectRef,
  SqlServerConnection,
} from '@/types';

/* ----------------------------- CSV 输入 ----------------------------- */

export function InputCsvPanel({ node }: PanelProps) {
  const [config, patch] = useNodeConfig<InputCsvConfig>(node);
  return (
    <div className="flex flex-col gap-4">
      <Field label="CSV 文件" hint="可直接填写路径，或点击上传按钮导入本地文件。">
        <FilePathField
          value={config.path ?? ''}
          onChange={(path) => patch({ path })}
          accept=".csv,.txt,.tsv"
          placeholder="data.csv 或绝对路径"
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

        <Field label="编码">
          <Select
            value={config.encoding ?? 'utf-8'}
            onValueChange={(value) => patch({ encoding: value as 'utf-8' | 'gbk' })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="utf-8">UTF-8</SelectItem>
              <SelectItem value="gbk">GBK</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <label className="flex items-center justify-between rounded-md border border-border p-2.5 text-xs text-muted-foreground">
        首行为表头
        <Switch
          checked={config.hasHeader ?? true}
          onCheckedChange={(checked) => patch({ hasHeader: checked })}
        />
      </label>
    </div>
  );
}

/* ----------------------------- Excel 输入 ----------------------------- */

export function InputExcelPanel({ node }: PanelProps) {
  const { adapter } = useDesignerHost();
  const [config, patch] = useNodeConfig<InputExcelConfig>(node);
  const [sheets, setSheets] = useState<string[]>([]);
  const [loadingSheets, setLoadingSheets] = useState(false);

  const loadSheets = useCallback(async (path: string) => {
    if (!path || !adapter.listSheets) {
      setSheets([]);
      return;
    }
    setLoadingSheets(true);
    try {
      const sheetNames = await adapter.listSheets(path);
      setSheets(sheetNames);
    } catch {
      setSheets([]);
    } finally {
      setLoadingSheets(false);
    }
  }, [adapter]);

  useEffect(() => {
    void loadSheets(config.path ?? '');
  }, [config.path, loadSheets]);

  const handleUploaded = (result: FileUploadResult) => {
    if (result.sheets && result.sheets.length > 0) {
      setSheets(result.sheets);
      if (!config.sheet) patch({ sheet: result.sheets[0] });
    }
  };

  const sheetValue = config.sheet ?? '';
  const hasFallback = Boolean(sheetValue) && !sheets.includes(sheetValue);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Excel 文件" hint="支持 .xlsx / .xls，可填写路径或上传本地文件。">
        <FilePathField
          value={config.path ?? ''}
          onChange={(path) => patch({ path })}
          accept=".xlsx,.xls"
          placeholder="data.xlsx 或绝对路径"
          onUploaded={handleUploaded}
        />
      </Field>

      <Field
        label="工作表"
        hint={sheets.length > 0 ? `共 ${sheets.length} 个工作表` : '未填写工作表时读取第一个工作表'}
      >
        <div className="flex items-center gap-1.5">
          {sheets.length > 0 ? (
            <Select value={sheetValue} onValueChange={(value) => patch({ sheet: value })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="选择工作表" />
              </SelectTrigger>
              <SelectContent>
                {hasFallback && <SelectItem value={sheetValue}>{sheetValue}</SelectItem>}
                {sheets.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={sheetValue}
              onChange={(event) => patch({ sheet: event.target.value })}
              placeholder="Sheet1"
              className="h-8 text-xs"
            />
          )}
          {adapter.listSheets && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title="刷新工作表列表"
              disabled={loadingSheets || !config.path}
              onClick={() => void loadSheets(config.path ?? '')}
            >
              {loadingSheets ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          )}
        </div>
      </Field>

      <label className="flex items-center justify-between rounded-md border border-border p-2.5 text-xs text-muted-foreground">
        首行为表头
        <Switch
          checked={config.hasHeader ?? true}
          onCheckedChange={(checked) => patch({ hasHeader: checked })}
        />
      </label>
    </div>
  );
}

/* ----------------------------- SQL Server 输入 ----------------------------- */

export function InputSqlServerPanel({ node }: PanelProps) {
  const { adapter } = useDesignerHost();
  const [config, patch] = useNodeConfig<InputSqlServerConfig>(node);
  const [objects, setObjects] = useState<SqlObjectRef[]>([]);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [objectError, setObjectError] = useState<string | null>(null);
  const connection = config.connection;

  const loadObjects = useCallback(async (conn: SqlServerConnection) => {
    if (!conn?.server || !conn?.database || !adapter.listSqlObjects) {
      setObjects([]);
      setObjectError(null);
      return;
    }
    setLoadingObjects(true);
    setObjectError(null);
    try {
      const refs = await adapter.listSqlObjects(conn);
      setObjects(refs);
    } catch (err) {
      setObjects([]);
      setObjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingObjects(false);
    }
  }, [adapter]);

  useEffect(() => {
    void loadObjects(connection);
    // 连接关键字段变化时重新拉取表/视图列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.server, connection.port, connection.database, connection.user, loadObjects]);

  const objectValue = config.object ? `${config.object.schema}.${config.object.name}` : '';
  const hasObjectFallback =
    Boolean(objectValue) && !objects.some((obj) => `${obj.schema}.${obj.name}` === objectValue);

  const handleSelectObject = (value: string) => {
    const picked = objects.find((obj) => `${obj.schema}.${obj.name}` === value);
    if (picked) patch({ object: picked });
  };

  const handleLoad = () => {
    const obj = config.object;
    if (!obj) return;
    patch({ query: `SELECT * FROM [${obj.schema}].[${obj.name}]` });
  };

  return (
    <div className="flex flex-col gap-4">
      <SqlConnectionForm
        connection={connection}
        onChange={(next) => patch({ connection: next })}
      />

      <Field label="表 / 视图" hint="选择数据库下的一张表或视图，点击「加载」生成查询。">
        <div className="flex items-center gap-1.5">
          {objects.length > 0 ? (
            <Select value={objectValue} onValueChange={handleSelectObject}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="选择表 / 视图" />
              </SelectTrigger>
              <SelectContent>
                {hasObjectFallback && <SelectItem value={objectValue}>{objectValue}</SelectItem>}
                {objects.map((obj) => {
                  const value = `${obj.schema}.${obj.name}`;
                  return (
                    <SelectItem key={value} value={value}>
                      {value}
                      {obj.type === 'view' ? ' · 视图' : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={objectValue}
              readOnly
              placeholder="请先连接并选择数据库"
              className="h-8 text-xs"
            />
          )}
          {adapter.listSqlObjects && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title="刷新表 / 视图列表"
              disabled={loadingObjects || !connection.server || !connection.database}
              onClick={() => void loadObjects(connection)}
            >
              {loadingObjects ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          )}
        </div>
      </Field>

      {objectError && (
        <p className="text-[11px] text-destructive" title={objectError}>
          {objectError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!config.object}
          onClick={handleLoad}
        >
          <Download />
          加载
        </Button>
        <span className="text-[11px] text-muted-foreground">生成默认查询，可在下方手动改写。</span>
      </div>

      <Field label="SQL 查询" hint="选表后自动生成，可手动改写（高级）。">
        <Textarea
          value={config.query ?? ''}
          onChange={(event) => patch({ query: event.target.value })}
          placeholder="SELECT * FROM dbo.Customers"
          spellCheck={false}
          className="min-h-[120px] font-mono text-xs"
        />
      </Field>
    </div>
  );
}
