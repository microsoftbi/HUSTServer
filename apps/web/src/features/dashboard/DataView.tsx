import { useEffect, useMemo, useState } from 'react';
import { Database, FileSpreadsheet, Plus, SlidersHorizontal, Table2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@bi/components/ui/button';
import { Badge } from '@bi/components/ui/badge';
import { ScrollArea } from '@bi/components/ui/scroll-area';
import { Separator } from '@bi/components/ui/separator';
import { Input } from '@bi/components/ui/input';
import { Label } from '@bi/components/ui/label';
import { Switch } from '@bi/components/ui/switch';
import { DataTable } from '@bi/components/DataTable';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@bi/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@bi/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@bi/components/ui/select';
import { api, ApiClientError } from '../../api.js';
import { cn } from '@bi/lib/utils';
import { loadFileDataset, loadModelDataset, querySqlDataset } from '@bi/services/dataSource';
import { useDatasetStore } from '@bi/stores/datasetStore';
import {
  DECIMAL_OPTIONS,
  DEFAULT_FIELD_FORMAT,
  UNIT_OPTIONS,
  formatNumber,
} from '@bi/lib/format';
import type { Dataset, DatasetSource, FieldFormat } from '@bi/types';

const SOURCE_LABEL: Record<DatasetSource, string> = {
  csv: 'CSV',
  excel: 'Excel',
  sql: 'SQL',
  model: '模型',
};

interface ResourceFile {
  name: string;
  path: string;
  size: number;
}

interface TableInfo {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

type AddMode = 'file' | 'table' | 'model';

interface ModelOption {
  name: string;
  rowCount: number;
  columns: unknown[];
}

function tableKey(t: TableInfo): string {
  return `${t.schema}.${t.name}`;
}

function tableQuery(t: TableInfo): string {
  return `SELECT TOP 1000 * FROM [${t.schema}].[${t.name}]`;
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/** 左侧「数据」视图：组织仪表板的数据集，并预览其内容 */
export function DataView() {
  const datasets = useDatasetStore((s) => s.datasets);
  const addDataset = useDatasetStore((s) => s.addDataset);
  const removeDataset = useDatasetStore((s) => s.removeDataset);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);

  const selected =
    datasets.find((d) => d.id === selectedId) ?? datasets[0] ?? null;

  useEffect(() => {
    if (datasets.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!datasets.some((d) => d.id === selectedId)) {
      setSelectedId(datasets[0].id);
    }
  }, [datasets, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-card">
        <div className="flex shrink-0 items-center gap-2 px-3 py-3">
          <span className="flex-1 text-sm font-semibold">数据集</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="添加数据集">
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setAddMode('file')}>
                <FileSpreadsheet className="h-4 w-4" />
                从资源库文件（CSV/Excel）
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAddMode('table')}>
                <Table2 className="h-4 w-4" />
                从连接的数据库表
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAddMode('model')}>
                <Database className="h-4 w-4" />
                从数据模型（DuckDB）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Separator />

        {datasets.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              还没有数据集，从资源库文件、数据库表或数据模型添加。
            </p>
            <Button size="sm" onClick={() => setAddMode('file')}>
              添加数据集
            </Button>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="space-y-0.5 p-2">
              {datasets.map((d) => (
                <li key={d.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(d.id);
                      }
                    }}
                    className={cn(
                      'group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-accent',
                      d.id === selected?.id && 'bg-accent font-medium',
                    )}
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{d.name}</span>
                    <Badge
                      variant="secondary"
                      className="shrink-0 px-1.5 py-0 text-[10px]"
                    >
                      {SOURCE_LABEL[d.source]}
                    </Badge>
                    <button
                      type="button"
                      aria-label={`删除数据集 ${d.name}`}
                      title="删除数据集"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDataset(d.id);
                      }}
                      className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background group-hover:block"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col p-4">
        {selected ? (
          <>
            <div className="mb-3 flex shrink-0 items-center gap-2">
              <span className="font-medium">{selected.name}</span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {SOURCE_LABEL[selected.source]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {selected.rows.length} 行 · {selected.columns.length} 列
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 gap-1.5 text-xs"
                onClick={() => setFormatOpen(true)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                字段格式
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <DataTable columns={selected.columns} rows={selected.rows} formats={selected.formats} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Database className="h-8 w-8 text-muted-foreground/40" />
            <p>在左侧添加数据集后在此预览数据</p>
          </div>
        )}
      </section>

      <AddDatasetDialog
        mode={addMode}
        onClose={() => setAddMode(null)}
        onAdded={(ds) => {
          addDataset(ds);
          setSelectedId(ds.id);
          toast.success(`已添加数据集「${ds.name}」`);
        }}
      />

      {selected ? (
        <FieldFormatDialog
          dataset={selected}
          open={formatOpen}
          onClose={() => setFormatOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface AddDatasetDialogProps {
  mode: AddMode | null;
  onClose: () => void;
  onAdded: (dataset: Dataset) => void;
}

function AddDatasetDialog({ mode, onClose, onAdded }: AddDatasetDialogProps) {
  const open = mode !== null;
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [connections, setConnections] = useState<Array<{ id: string; name: string }>>([]);
  const [connectionId, setConnectionId] = useState('');
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableKeyValue, setTableKeyValue] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelNameValue, setModelNameValue] = useState('');
  const [preview, setPreview] = useState<Dataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 打开时按来源拉取候选列表并重置状态
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setName('');
    setError(null);
    setTableKeyValue('');
    setTables([]);
    setModelNameValue('');
    if (mode === 'file') {
      void (async () => {
        try {
          const tree = await api.get<{ files: ResourceFile[] }>('/api/resources/tree');
          setFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name)));
        } catch {
          setFiles([]);
        }
      })();
    } else if (mode === 'model') {
      void (async () => {
        try {
          const res = await api.get<{ items: ModelOption[] }>('/api/models');
          setModels(res.items);
          setModelNameValue((cur) => cur || res.items[0]?.name || '');
        } catch {
          setModels([]);
        }
      })();
    } else {
      void (async () => {
        try {
          const list = await api.get<Array<{ id: string; name: string }>>('/api/connections');
          setConnections(list);
          setConnectionId((cur) => cur || list[0]?.id || '');
        } catch {
          setConnections([]);
        }
      })();
    }
  }, [open, mode]);

  // 选定连接后列出库中的表/视图
  useEffect(() => {
    if (!open || mode !== 'table' || !connectionId) return;
    let cancelled = false;
    setTablesLoading(true);
    setTables([]);
    setTableKeyValue('');
    setPreview(null);
    void (async () => {
      try {
        const res = await api.post<{ tables: TableInfo[] }>('/api/data/tables', {
          body: { connectionId },
        });
        if (!cancelled) setTables(res.tables);
      } catch (err) {
        if (!cancelled) setError(errText(err));
      } finally {
        if (!cancelled) setTablesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, connectionId]);

  async function loadPreview() {
    setError(null);
    setLoading(true);
    try {
      if (mode === 'file') {
        if (!selectedPath) return;
        const f = files.find((x) => x.path === selectedPath);
        const ds = await loadFileDataset(f?.name ?? '文件数据集', selectedPath);
        setPreview(ds);
        setName((cur) => cur || (f?.name ?? ''));
        return;
      }
      if (mode === 'model') {
        if (!modelNameValue) return;
        const ds = await loadModelDataset(modelNameValue, modelNameValue);
        setPreview(ds);
        setName((cur) => cur || modelNameValue);
        return;
      }
      const t = tables.find((x) => tableKey(x) === tableKeyValue);
      if (!connectionId || !t) return;
      const ds = await querySqlDataset(t.name, connectionId, tableQuery(t));
      setPreview(ds);
      setName((cur) => cur || t.name);
    } catch (err) {
      setPreview(null);
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }

  function save() {
    if (!preview) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写数据集名称');
      return;
    }
    onAdded({ ...preview, name: trimmed });
    onClose();
  }

  const canLoad =
    mode === 'file'
      ? Boolean(selectedPath)
      : mode === 'model'
        ? Boolean(modelNameValue)
        : Boolean(tableKeyValue);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'table'
              ? '从数据库表添加数据集'
              : mode === 'model'
                ? '从数据模型添加数据集'
                : '从资源库文件添加数据集'}
          </DialogTitle>
        </DialogHeader>

        {mode === 'table' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>连接</Label>
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger className="w-72">
                  <SelectValue
                    placeholder={connections.length === 0 ? '暂无可用连接' : '选择连接'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>数据表</Label>
              <Select
                value={tableKeyValue}
                onValueChange={(v) => {
                  setTableKeyValue(v);
                  setPreview(null);
                }}
                disabled={tablesLoading || tables.length === 0}
              >
                <SelectTrigger className="w-72">
                  <SelectValue
                    placeholder={
                      tablesLoading
                        ? '加载中…'
                        : tables.length === 0
                          ? '无可选数据表'
                          : '选择数据表'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((t) => (
                    <SelectItem key={tableKey(t)} value={tableKey(t)}>
                      {t.schema}.{t.name}
                      {t.type === 'view' ? '（视图）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : mode === 'model' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>数据模型</Label>
              <Select
                value={modelNameValue}
                onValueChange={(v) => {
                  setModelNameValue(v);
                  setPreview(null);
                }}
              >
                <SelectTrigger className="w-72">
                  <SelectValue
                    placeholder={models.length === 0 ? '暂无数据模型' : '选择模型'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}（{m.rowCount} 行 · {m.columns.length} 列）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>资源文件</Label>
              <Select
                value={selectedPath}
                onValueChange={(v) => {
                  setSelectedPath(v);
                  setPreview(null);
                }}
              >
                <SelectTrigger className="w-72">
                  <SelectValue
                    placeholder={files.length === 0 ? '资源库暂无 CSV/Excel' : '选择文件'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {files.map((f) => (
                    <SelectItem key={f.path} value={f.path}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div>
          <Button
            size="sm"
            disabled={!canLoad || loading}
            onClick={() => void loadPreview()}
          >
            {loading ? '载入中…' : '载入'}
          </Button>
        </div>

        {error ? <p className="break-all text-sm text-destructive">{error}</p> : null}

        {preview ? (
          <div className="min-w-0 space-y-2">
            <div className="h-64 w-full overflow-hidden rounded border">
              <DataTable columns={preview.columns} rows={preview.rows} />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="ds-name">数据集名称</Label>
                <Input
                  id="ds-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <Button onClick={save}>存为数据集</Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">选择来源并载入后在此预览结果。</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface FieldFormatDialogProps {
  dataset: Dataset;
  open: boolean;
  onClose: () => void;
}

/** 字段级数值格式设置：小数位、千分位、显示单位（对应 Power BI 的列/度量值格式） */
function FieldFormatDialog({ dataset, open, onClose }: FieldFormatDialogProps) {
  const updateDataset = useDatasetStore((s) => s.updateDataset);
  const numericColumns = useMemo(
    () => dataset.columns.filter((c) => c.type === 'number'),
    [dataset.columns],
  );
  const [field, setField] = useState('');

  useEffect(() => {
    if (!open) return;
    setField((prev) =>
      numericColumns.some((c) => c.name === prev) ? prev : (numericColumns[0]?.name ?? ''),
    );
  }, [open, dataset.id, numericColumns]);

  const format = (field && dataset.formats?.[field]) || DEFAULT_FIELD_FORMAT;

  const sample = useMemo(() => {
    const index = dataset.columns.findIndex((c) => c.name === field);
    if (index < 0) return undefined;
    for (const row of dataset.rows) {
      const value = row[index];
      if (typeof value === 'number') return value;
    }
    return undefined;
  }, [dataset.columns, dataset.rows, field]);

  function patch(next: Partial<FieldFormat>) {
    if (!field) return;
    updateDataset(dataset.id, {
      formats: { ...dataset.formats, [field]: { ...format, ...next } },
    });
  }

  function reset() {
    if (!field || !dataset.formats?.[field]) return;
    const next = { ...dataset.formats };
    delete next[field];
    updateDataset(dataset.id, { formats: next });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>字段格式 · {dataset.name}</DialogTitle>
        </DialogHeader>

        {numericColumns.length === 0 ? (
          <p className="text-sm text-muted-foreground">该数据集没有数值字段可配置。</p>
        ) : (
          <div className="flex gap-4">
            <aside className="w-44 shrink-0">
              <ScrollArea className="h-64 rounded-md border">
                <ul className="space-y-0.5 p-1">
                  {numericColumns.map((c) => (
                    <li key={c.name}>
                      <button
                        type="button"
                        onClick={() => setField(c.name)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                          c.name === field && 'bg-accent font-medium',
                        )}
                      >
                        <span className="flex-1 truncate">{c.name}</span>
                        {dataset.formats?.[c.name] ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            已设置
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </aside>

            <section className="min-w-0 flex-1 space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">小数位数</Label>
                <Select
                  value={String(format.decimals)}
                  onValueChange={(v) => patch({ decimals: Number(v) })}
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
                  value={format.unit}
                  onValueChange={(v) => patch({ unit: v as FieldFormat['unit'] })}
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

              <div className="flex items-center justify-between py-0.5">
                <Label htmlFor="field-thousands" className="text-xs">
                  使用千分位
                </Label>
                <Switch
                  id="field-thousands"
                  checked={format.thousands}
                  onCheckedChange={(v) => patch({ thousands: v })}
                />
              </div>

              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <span className="text-muted-foreground">预览：</span>
                <span className="font-medium tabular-nums">
                  {formatNumber(sample ?? 1234567.89, format)}
                </span>
              </div>

              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={!dataset.formats?.[field]}
                onClick={reset}
              >
                恢复默认
              </Button>
            </section>
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            完成
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
