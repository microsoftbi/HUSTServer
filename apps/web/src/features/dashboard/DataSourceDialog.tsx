import { useEffect, useState } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Textarea } from './components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { DataTable } from './components/DataTable';
import { api, ApiClientError } from '../../api.js';
import { datasetFromQueryResult, loadFileDataset } from './services/dataSource';
import type { Dataset, QueryResult } from './types';

interface DataSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (dataset: Dataset) => void;
}

interface ResourceFile {
  name: string;
  path: string;
  size: number;
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

export function DataSourceDialog({ open, onOpenChange, onSaved }: DataSourceDialogProps) {
  const [msgBox, setMsgBox] = useState<{ title: string; msg: string } | null>(null);
  // SQL Tab
  const [connections, setConnections] = useState<Array<{ id: string; name: string }>>([]);
  const [connectionId, setConnectionId] = useState('');
  const [sqlText, setSqlText] = useState('SELECT TOP 100 * FROM ');
  const [sqlPreview, setSqlPreview] = useState<Dataset | null>(null);
  const [sqlTruncated, setSqlTruncated] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [running, setRunning] = useState(false);
  // 文件 Tab
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [filePreview, setFilePreview] = useState<Dataset | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileLabel, setFileLabel] = useState('');

  // msgBox 支持 Esc 关闭（与 ConnectionsPage 的 msgBox 行为一致）
  useEffect(() => {
    if (!msgBox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMsgBox(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [msgBox]);

  // 打开时拉取连接列表与资源文件列表
  useEffect(() => {
    if (!open) return;
    setSqlPreview(null);
    setSqlTruncated(false);
    setFilePreview(null);
    setDatasetName('');
    setMsgBox(null);
    void (async () => {
      try {
        const list = await api.get<Array<{ id: string; name: string }>>('/api/connections');
        setConnections(list);
        setConnectionId((cur) => cur || list[0]?.id || '');
      } catch {
        setConnections([]);
      }
      try {
        const tree = await api.get<{ files: ResourceFile[] }>('/api/resources/tree');
        setFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name)));
      } catch {
        setFiles([]);
      }
    })();
  }, [open]);

  async function runSql() {
    if (!connectionId) {
      setMsgBox({ title: '执行失败', msg: '请先选择连接' });
      return;
    }
    if (!sqlText.trim()) {
      setMsgBox({ title: '执行失败', msg: '请输入 SQL 语句' });
      return;
    }
    setRunning(true);
    try {
      const result = await api.post<QueryResult>('/api/data/query', {
        body: { connectionId, query: sqlText.trim(), limit: 100 },
      });
      setSqlPreview(datasetFromQueryResult('SQL 数据集', connectionId, sqlText.trim(), result));
      setSqlTruncated(result.truncated);
    } catch (err) {
      setSqlPreview(null);
      setMsgBox({ title: '执行失败', msg: errText(err) });
    } finally {
      setRunning(false);
    }
  }

  async function loadFile() {
    if (!selectedPath) return;
    setFileLoading(true);
    try {
      const file = files.find((f) => f.path === selectedPath);
      const ds = await loadFileDataset(file?.name ?? '文件数据集', selectedPath);
      setFilePreview(ds);
      setFileLabel(file?.name ?? selectedPath);
    } catch (err) {
      setFilePreview(null);
      setMsgBox({ title: '载入失败', msg: errText(err) });
    } finally {
      setFileLoading(false);
    }
  }

  function saveSql() {
    if (!sqlPreview) return;
    const name = datasetName.trim();
    if (!name) {
      setMsgBox({ title: '保存失败', msg: '请填写数据集名称' });
      return;
    }
    onSaved({ ...sqlPreview, name });
  }

  function saveFile() {
    if (!filePreview) return;
    const name = datasetName.trim();
    if (!name) {
      setMsgBox({ title: '保存失败', msg: '请填写数据集名称' });
      return;
    }
    onSaved({ ...filePreview, name });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>添加数据集</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="sql">
          <TabsList>
            <TabsTrigger value="sql">从连接（SQL）</TabsTrigger>
            <TabsTrigger value="file">从资源库（CSV/Excel）</TabsTrigger>
          </TabsList>

          <TabsContent value="sql" className="space-y-3">
            <div className="space-y-1.5">
              <Label>连接</Label>
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder={connections.length === 0 ? '暂无可用连接' : '选择连接'} />
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
              <Label>SQL</Label>
              <Textarea rows={4} value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={running} onClick={() => void runSql()}>
                {running ? '执行中…' : '执行'}
              </Button>
              {sqlTruncated ? <span className="text-xs text-slate-500">预览仅显示前 100 行</span> : null}
            </div>
            {sqlPreview ? (
              <div className="space-y-2">
                <div className="max-h-64 overflow-auto rounded border">
                  <DataTable columns={sqlPreview.columns} rows={sqlPreview.rows} />
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="ds-name">数据集名称</Label>
                    <Input id="ds-name" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
                  </div>
                  <Button onClick={saveSql}>存为数据集</Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">执行 SQL 后在此预览结果。</p>
            )}
          </TabsContent>

          <TabsContent value="file" className="space-y-3">
            <div className="space-y-1.5">
              <Label>资源文件</Label>
              <Select value={selectedPath} onValueChange={setSelectedPath}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder={files.length === 0 ? '资源库暂无 CSV/Excel' : '选择文件'} />
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
            <Button size="sm" disabled={!selectedPath || fileLoading} onClick={() => void loadFile()}>
              {fileLoading ? '载入中…' : '载入'}
            </Button>
            {filePreview ? (
              <div className="space-y-2">
                <div className="max-h-64 overflow-auto rounded border">
                  <DataTable columns={filePreview.columns} rows={filePreview.rows} />
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="file-ds-name">数据集名称</Label>
                    <Input id="file-ds-name" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} placeholder={fileLabel} />
                  </div>
                  <Button onClick={saveFile}>存为数据集</Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">选择文件并载入后在此预览。</p>
            )}
          </TabsContent>
        </Tabs>

        {msgBox && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMsgBox(null)}>
            <div className="w-full max-w-sm rounded bg-white p-4 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
              <h2 className="font-medium">{msgBox.title}</h2>
              <p className="mt-2 break-all text-red-600">{msgBox.msg}</p>
              <div className="mt-4 flex justify-end">
                <button type="button" className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={() => setMsgBox(null)}>
                  确定
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
