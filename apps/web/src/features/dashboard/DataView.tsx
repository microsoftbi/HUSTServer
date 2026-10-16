import { useEffect, useState } from 'react';
import { Database, FileSpreadsheet, Plus, Table2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@bi/components/ui/button';
import { Badge } from '@bi/components/ui/badge';
import { ScrollArea } from '@bi/components/ui/scroll-area';
import { Separator } from '@bi/components/ui/separator';
import { Input } from '@bi/components/ui/input';
import { Label } from '@bi/components/ui/label';
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
import { loadFileDataset, querySqlDataset } from '@bi/services/dataSource';
import { useDatasetStore } from '@bi/stores/datasetStore';
import type { Dataset, DatasetSource } from '@bi/types';

const SOURCE_LABEL: Record<DatasetSource, string> = {
  csv: 'CSV',
  excel: 'Excel',
  sql: 'SQL',
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

type AddMode = 'file' | 'table';

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
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Separator />

        {datasets.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              还没有数据集，从资源库文件或数据库表添加。
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
            </div>
            <div className="min-h-0 flex-1">
              <DataTable columns={selected.columns} rows={selected.rows} />
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
    if (mode === 'file') {
      void (async () => {
        try {
          const tree = await api.get<{ files: ResourceFile[] }>('/api/resources/tree');
          setFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name)));
        } catch {
          setFiles([]);
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

  const canLoad = mode === 'file' ? Boolean(selectedPath) : Boolean(tableKeyValue);

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
            {mode === 'table' ? '从数据库表添加数据集' : '从资源库文件添加数据集'}
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

        {error ? <p className="break-all text-sm text-red-600">{error}</p> : null}

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
