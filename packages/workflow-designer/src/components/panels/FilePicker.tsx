import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  ArrowUp,
  ChevronRight,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDesignerHost } from '@/context';
import { shortenPath } from '@/lib/format';
import type { FileUploadResult, ResourceEntryRef } from '@/types';

interface Props {
  value: string;
  onChange: (path: string) => void;
  accept?: string;
  placeholder?: string;
  /** 上传成功后回调，便于 Excel 面板读取工作表列表。 */
  onUploaded?: (result: FileUploadResult) => void;
}

/** 从 accept 串（如 ".csv,.txt"）解析出扩展名列表。 */
function acceptExtensions(accept?: string): string[] {
  if (!accept) return [];
  return accept
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.startsWith('.'));
}

function matchesExtensions(name: string, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface PickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  extensions: string[];
  onPick: (file: ResourceEntryRef) => void;
}

/** 资源管理器式资源库选择弹窗（宿主未提供 listResourceEntries 能力时不可达）。 */
function ResourcePickerDialog({ open, onOpenChange, extensions, onPick }: PickerProps) {
  const { adapter } = useDesignerHost();
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<ResourceEntryRef[]>([]);
  const [selected, setSelected] = useState<ResourceEntryRef | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(
    async (target: string) => {
      if (!adapter.listResourceEntries) return;
      setLoading(true);
      setError(null);
      try {
        const result = await adapter.listResourceEntries(target);
        setDir(result.dir);
        setEntries(result.entries);
        setSelected(null);
      } catch (err) {
        setEntries([]);
        setSelected(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [adapter],
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDir('');
    setSelected(null);
    void load('');
  }, [open, load]);

  const enter = (name: string) => {
    const next = dir ? `${dir}/${name}` : name;
    void load(next);
  };

  const goUp = () => {
    const parts = dir.split('/').filter(Boolean);
    parts.pop();
    void load(parts.join('/'));
  };

  const confirmPick = (file: ResourceEntryRef) => {
    onPick(file);
    onOpenChange(false);
  };

  const keyword = query.trim().toLowerCase();
  const folders = entries
    .filter((entry) => entry.kind === 'folder')
    .filter((entry) => !keyword || entry.name.toLowerCase().includes(keyword))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((entry) => entry.kind === 'file' && matchesExtensions(entry.name, extensions))
    .filter((entry) => !keyword || entry.name.toLowerCase().includes(keyword))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = [...folders, ...files];

  const crumbs = dir.split('/').filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>从资源库选择文件</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title="上一级"
            disabled={loading || !dir}
            onClick={goUp}
          >
            <ArrowUp />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground">
            <button
              type="button"
              className="shrink-0 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
              onClick={() => void load('')}
            >
              资源库
            </button>
            {crumbs.map((crumb, index) => {
              const target = crumbs.slice(0, index + 1).join('/');
              return (
                <span key={target} className="flex shrink-0 items-center gap-0.5">
                  <ChevronRight className="size-3" />
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                    onClick={() => void load(target)}
                  >
                    {crumb}
                  </button>
                </span>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title="刷新"
            disabled={loading}
            onClick={() => void load(dir)}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>

        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称筛选当前文件夹"
          className="h-8 text-xs"
        />

        <div className="max-h-72 overflow-y-auto rounded-md border border-border">
          {shown.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {loading ? '加载中…' : '当前文件夹暂无文件夹或符合类型的文件'}
            </p>
          ) : (
            shown.map((entry) =>
              entry.kind === 'folder' ? (
                <button
                  key={`folder:${entry.name}`}
                  type="button"
                  title={entry.name}
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-accent"
                  onClick={() => enter(entry.name)}
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ) : (
                <button
                  key={`file:${entry.name}`}
                  type="button"
                  title={entry.path}
                  className={`flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-accent ${
                    selected?.name === entry.name ? 'bg-accent' : ''
                  }`}
                  onClick={() => setSelected(entry)}
                  onDoubleClick={() => confirmPick(entry)}
                >
                  <FileSpreadsheet className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{entry.name}</span>
                  {entry.size != null && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatSize(entry.size)}
                    </span>
                  )}
                </button>
              ),
            )
          )}
        </div>

        {error && <p className="text-[10px] text-destructive">{error}</p>}

        <DialogFooter>
          <span className="mr-auto truncate text-[10px] text-muted-foreground" title={selected?.path}>
            {selected ? selected.name : '未选择文件'}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!selected?.path}
            onClick={() => selected && confirmPick(selected)}
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 文件路径输入 + 上传按钮 + 资源库选择按钮。
 * 上传后的文件保存到后端 UPLOAD_DIR，返回其绝对路径写回配置；
 * 资源库选择同样写回文件的绝对路径（引擎按绝对路径直接读取）。
 */
export function FilePathField({ value, onChange, accept, placeholder, onUploaded }: Props) {
  const { adapter } = useDesignerHost();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      if (!adapter.uploadFile) return;
      const uploaded = await adapter.uploadFile(file);
      onChange(uploaded.path);
      onUploaded?.(uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? '选择或输入文件路径'}
          title={value}
          className="h-8 text-xs"
        />
        {adapter.listResourceEntries && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title="从资源库选择"
            onClick={() => setPickerOpen(true)}
          >
            <FolderOpen />
          </Button>
        )}
        {adapter.uploadFile && (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title="上传文件"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              className="hidden"
              onChange={handleFile}
            />
          </>
        )}
      </div>
      {value && (
        <p className="truncate text-[10px] text-muted-foreground" title={value}>
          {shortenPath(value)}
        </p>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
      <ResourcePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        extensions={acceptExtensions(accept)}
        onPick={(file) => {
          if (file.path) onChange(file.path);
        }}
      />
    </div>
  );
}
