import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardHeader, CardTitle } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Field, Input } from '../components/ui/input.js';
import { Modal } from '../components/ui/modal.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';

interface ResourceEntry {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
}

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface TreeBranchProps {
  nodes: FolderNode[];
  depth: number;
  currentPath: string;
  expanded: Set<string>;
  dragOver: string | null;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
  onDropInto: (toDir: string) => void;
  onDragOverDir: (path: string | null) => void;
}

function TreeBranch(props: TreeBranchProps) {
  const { nodes, depth, currentPath, expanded, dragOver, onToggle, onNavigate, onDropInto, onDragOverDir } = props;
  return (
    <>
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path);
        const isCurrent = currentPath === node.path;
        const isOver = dragOver === node.path;
        const rowClass = isOver
          ? 'bg-primary/10 ring-1 ring-primary/40'
          : isCurrent
            ? 'bg-primary/10 font-medium text-primary'
            : 'hover:bg-accent';
        return (
          <div key={node.path}>
            <div
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm ${rowClass}`}
              style={{ paddingLeft: depth * 12 }}
              onDragOver={(e) => {
                e.preventDefault();
                onDragOverDir(node.path);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) onDragOverDir(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDropInto(node.path);
              }}
            >
              <button
                className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(node.path);
                }}
              >
                {node.children.length > 0 ? (isOpen ? '▾' : '▸') : ''}
              </button>
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button className="flex-1 truncate text-left" onClick={() => onNavigate(node.path)}>
                {node.name}
              </button>
            </div>
            {isOpen && node.children.length > 0 && (
              <TreeBranch {...props} nodes={node.children} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </>
  );
}

/** 资源管理：类资源管理器界面，支持目录树、图标/列表视图、右键菜单与拖拽移动。 */
export function ResourcesPage() {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<ResourceEntry[]>([]);
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ entry: ResourceEntry; name: string } | null>(null);
  const [confirm, setConfirm] = useState<ResourceEntry[] | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: ResourceEntry | null } | null>(null);
  const dragItems = useRef<ResourceEntry[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback(async (rel: string) => {
    try {
      const res = await api.get<{ path: string; entries: ResourceEntry[] }>(
        `/api/resources?path=${encodeURIComponent(rel)}`,
      );
      setPath(res.path);
      setEntries(res.entries);
      setSelected(new Set());
      anchorRef.current = null;
      setError(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add('');
        let acc = '';
        for (const seg of res.path ? res.path.split('/') : []) {
          acc = acc ? `${acc}/${seg}` : seg;
          next.add(acc);
        }
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const res = await api.get<{ folders: FolderNode[] }>('/api/resources/folders/tree');
      setTree(res.folders);
    } catch {
      // 目录树加载失败不阻塞主流程
    }
  }, []);

  useEffect(() => {
    void loadDir('');
    void loadTree();
  }, [loadDir, loadTree]);

  // 菜单打开后，点击任意处 / 按 Esc / 滚动即关闭。
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  /** 执行一次写操作后刷新目录与目录树；返回是否成功。 */
  async function run(op: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await op();
      await Promise.all([loadDir(path), loadTree()]);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitNewFolder(): Promise<void> {
    const name = (newFolder ?? '').trim();
    if (!name) return;
    const ok = await run(() => api.post('/api/resources/folders', { body: { path, name } }));
    if (ok) setNewFolder(null);
  }

  async function submitRename(): Promise<void> {
    if (!renaming) return;
    const { entry } = renaming;
    const name = renaming.name.trim();
    if (!name || name === entry.name) {
      setRenaming(null);
      return;
    }
    const url = entry.kind === 'folder' ? '/api/resources/folders' : '/api/resources/files';
    const ok = await run(() => api.request('PATCH', url, { body: { path: entry.path, name } }));
    if (ok) {
      setRenaming(null);
      window.alert('保存成功');
    }
  }

  /** 按目录顺序返回当前选中的条目。 */
  function selectedEntries(): ResourceEntry[] {
    return entries.filter((x) => selected.has(x.path));
  }

  /** 删除：批量删除传入的目标条目。 */
  async function submitDelete(targets: ResourceEntry[]): Promise<void> {
    const ok = await run(async () => {
      for (const t of targets) {
        const url = t.kind === 'folder' ? '/api/resources/folders' : '/api/resources/files';
        await api.del(`${url}?path=${encodeURIComponent(t.path)}`);
      }
    });
    if (ok) setConfirm(null);
  }

  function uploadFile(file: File): void {
    const form = new FormData();
    form.append('path', path);
    form.append('file', file);
    void run(() => api.post('/api/resources/files', { form }));
  }

  function download(entry: ResourceEntry): void {
    const a = document.createElement('a');
    a.href = `/api/resources/files/download?path=${encodeURIComponent(entry.path)}`;
    a.click();
  }

  function openEntry(entry: ResourceEntry): void {
    if (entry.kind === 'folder') void loadDir(entry.path);
    else download(entry);
  }

  /** 单击选中：Cmd/Ctrl 追加切换，Shift 区间选择，否则单选。 */
  function handleEntryClick(e: React.MouseEvent, entry: ResourceEntry): void {
    e.stopPropagation();
    if (e.shiftKey && anchorRef.current) {
      const paths = entries.map((x) => x.path);
      const a = paths.indexOf(anchorRef.current);
      const b = paths.indexOf(entry.path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(paths.slice(lo, hi + 1)));
        return;
      }
    }
    const additive = e.metaKey || e.ctrlKey;
    setSelected((prev) => {
      if (!additive) return new Set([entry.path]);
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    anchorRef.current = entry.path;
  }

  /** 拖拽起始：被拖条目在多选集合内则拖动整个集合，否则只拖该条目。 */
  function startDrag(e: React.DragEvent, entry: ResourceEntry): void {
    dragItems.current = selected.has(entry.path) ? selectedEntries() : [entry];
    e.dataTransfer.effectAllowed = 'move';
  }

  function openMenu(e: React.MouseEvent, entry: ResourceEntry | null): void {
    e.preventDefault();
    e.stopPropagation();
    if (entry) {
      setSelected((prev) => (prev.has(entry.path) ? prev : new Set([entry.path])));
      anchorRef.current = entry.path;
    }
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }

  async function dropInto(toDir: string): Promise<void> {
    const items = dragItems.current;
    dragItems.current = [];
    setDragOver(null);
    if (items.length === 0) return;
    // 已在目标目录中的项跳过；按层级由深到浅移动，避免父目录先被移走后子项路径失效。
    const moves = items
      .filter((it) => it.path.split('/').slice(0, -1).join('/') !== toDir)
      .sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    if (moves.length === 0) return;
    await run(async () => {
      for (const it of moves) {
        await api.post('/api/resources/move', { body: { from: it.path, to: toDir } });
      }
    });
  }

  const toggleExpand = (p: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const crumbs = path ? path.split('/') : [];
  const rootOver = dragOver === '__root__';
  const bgOver = dragOver === '__bg__';

  return (
    <div className="space-y-4">
      <PageHeader
        title="资源库"
        description="平台内的文件工作区：上传的数据文件可供工作流输入节点与「加载成模型」引用。"
      >
        <Button variant="outline" disabled={busy} onClick={() => setNewFolder('')}>
          <FolderPlus />
          新建文件夹
        </Button>
        <Button disabled={busy} onClick={() => fileInputRef.current?.click()}>
          <Upload />
          上传文件
        </Button>
      </PageHeader>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadFile(file);
          e.target.value = '';
        }}
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex h-[calc(100vh-11rem)] min-h-0 gap-4">
        <Card className="flex w-56 shrink-0 flex-col overflow-hidden">
          <CardHeader>
            <CardTitle>目录</CardTitle>
            <Folder className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <div className="min-h-0 flex-1 overflow-auto p-2 text-sm">
            <div
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${
                rootOver
                  ? 'bg-primary/10 ring-1 ring-primary/40'
                  : path === ''
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'hover:bg-accent'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver('__root__');
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void dropInto('');
              }}
            >
              <span className="w-4" />
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button className="flex-1 truncate text-left" onClick={() => void loadDir('')}>
                根目录
              </button>
            </div>
            <TreeBranch
              nodes={tree}
              depth={1}
              currentPath={path}
              expanded={expanded}
              dragOver={dragOver}
              onToggle={toggleExpand}
              onNavigate={(p) => void loadDir(p)}
              onDropInto={(toDir) => void dropInto(toDir)}
              onDragOverDir={setDragOver}
            />
          </div>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CardHeader>
            <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
              <button
                className={`rounded px-1 hover:bg-accent ${rootOver ? 'ring-1 ring-primary/40' : ''}`}
                onClick={() => void loadDir('')}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver('__root__');
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void dropInto('');
                }}
              >
                根目录
              </button>
              {crumbs.map((seg, i) => {
                const rel = crumbs.slice(0, i + 1).join('/');
                return (
                  <span key={rel} className="flex items-center gap-1">
                    <span className="text-muted-foreground">/</span>
                    {i === crumbs.length - 1 ? (
                      <span className="px-1 text-foreground">{seg}</span>
                    ) : (
                      <button
                        className="rounded px-1 text-primary hover:bg-accent"
                        onClick={() => void loadDir(rel)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOver(rel);
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          void dropInto(rel);
                        }}
                      >
                        {seg}
                      </button>
                    )}
                  </span>
                );
              })}
            </nav>
            <div className="flex items-center gap-2">
              {selected.size > 0 && <Badge tone="primary">已选 {selected.size} 项</Badge>}
              <div className="flex items-center gap-1">
                <Button
                  variant={view === 'grid' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setView('grid')}
                >
                  <LayoutGrid />
                  图标
                </Button>
                <Button
                  variant={view === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setView('list')}
                >
                  <List />
                  列表
                </Button>
              </div>
            </div>
          </CardHeader>

          <div
            className={`min-h-0 flex-1 overflow-auto ${bgOver ? 'bg-primary/10' : ''}`}
            onClick={() => {
              setSelected(new Set());
              anchorRef.current = null;
            }}
            onContextMenu={(e) => openMenu(e, null)}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver('__bg__');
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              void dropInto(path);
            }}
          >
            {entries.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title="此目录为空"
                description="使用右上角「上传文件」导入数据，或用「新建文件夹」创建多级目录。"
              />
            ) : view === 'grid' ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-1 p-3">
                {entries.map((entry) => {
                  const isSel = selected.has(entry.path);
                  const isOver = dragOver === entry.path;
                  return (
                    <div
                      key={entry.path}
                      draggable
                      onDragStart={(e) => startDrag(e, entry)}
                      onDragEnd={() => {
                        dragItems.current = [];
                        setDragOver(null);
                      }}
                      onClick={(e) => handleEntryClick(e, entry)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => openMenu(e, entry)}
                      onDragOver={
                        entry.kind === 'folder'
                          ? (e) => {
                              e.preventDefault();
                              setDragOver(entry.path);
                            }
                          : undefined
                      }
                      onDragLeave={
                        entry.kind === 'folder'
                          ? (e) => {
                              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
                            }
                          : undefined
                      }
                      onDrop={
                        entry.kind === 'folder'
                          ? (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void dropInto(entry.path);
                            }
                          : undefined
                      }
                      className={`flex cursor-default select-none flex-col items-center gap-1 rounded-md border p-2 text-center ${
                        isOver
                          ? 'border-primary/40 bg-primary/10'
                          : isSel
                            ? 'border-primary/60 bg-primary/10'
                            : 'border-transparent hover:bg-accent'
                      }`}
                    >
                      {entry.kind === 'folder' ? (
                        <Folder className="h-10 w-10 text-muted-foreground" />
                      ) : (
                        <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
                      )}
                      <span className="line-clamp-2 w-full break-all text-xs">
                        {entry.name}
                        {entry.kind === 'file' && (
                          <span className="block text-[10px] text-muted-foreground">{formatSize(entry.size)}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>名称</TableHead>
                    <TableHead className="w-24 text-right">大小</TableHead>
                    <TableHead className="w-44 text-right">修改时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const isSel = selected.has(entry.path);
                    const isOver = dragOver === entry.path;
                    return (
                      <TableRow
                        key={entry.path}
                        draggable
                        onDragStart={(e) => startDrag(e, entry)}
                        onDragEnd={() => {
                          dragItems.current = [];
                          setDragOver(null);
                        }}
                        onClick={(e) => handleEntryClick(e, entry)}
                        onDoubleClick={() => openEntry(entry)}
                        onContextMenu={(e) => openMenu(e, entry)}
                        onDragOver={
                          entry.kind === 'folder'
                            ? (e) => {
                                e.preventDefault();
                                setDragOver(entry.path);
                              }
                            : undefined
                        }
                        onDragLeave={
                          entry.kind === 'folder'
                            ? (e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null);
                              }
                            : undefined
                        }
                        onDrop={
                          entry.kind === 'folder'
                            ? (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void dropInto(entry.path);
                              }
                            : undefined
                        }
                        className={isOver ? 'bg-primary/10' : isSel ? 'bg-primary/10' : undefined}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {entry.kind === 'folder' ? (
                              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="truncate">{entry.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {entry.kind === 'file' ? formatSize(entry.size) : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {entry.kind === 'file' ? formatTime(entry.mtime) : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div
                            className="flex items-center justify-end gap-1"
                            onDoubleClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                openEntry(entry);
                              }}
                            >
                              {entry.kind === 'folder' ? <FolderOpen /> : <Download />}
                              {entry.kind === 'folder' ? '打开' : '下载'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenaming({ entry, name: entry.name });
                              }}
                            >
                              <Pencil />
                              重命名
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirm([entry]);
                              }}
                            >
                              <Trash2 />
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.entry === null ? (
            <>
              <MenuItem label="新建文件夹" onClick={() => setNewFolder('')} />
              <MenuItem label="上传文件" onClick={() => fileInputRef.current?.click()} />
              <MenuItem
                label="刷新"
                onClick={() => {
                  void loadDir(path);
                  void loadTree();
                }}
              />
            </>
          ) : (
            (() => {
              const entry = menu.entry as ResourceEntry;
              const targets = selected.has(entry.path) ? selectedEntries() : [entry];
              const multi = targets.length > 1;
              return (
                <>
                  {!multi && (
                    <MenuItem label={entry.kind === 'folder' ? '打开' : '下载'} onClick={() => openEntry(entry)} />
                  )}
                  {!multi && (
                    <MenuItem
                      label="重命名"
                      onClick={() => setRenaming({ entry, name: entry.name })}
                    />
                  )}
                  <MenuItem
                    label={multi ? `删除选中的 ${targets.length} 项` : '删除'}
                    danger
                    onClick={() => setConfirm(targets)}
                  />
                </>
              );
            })()
          )}
        </div>
      )}

      <Modal
        open={newFolder !== null}
        onClose={() => setNewFolder(null)}
        title="新建文件夹"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setNewFolder(null)}>
              取消
            </Button>
            <Button disabled={busy || !(newFolder ?? '').trim()} onClick={() => void submitNewFolder()}>
              创建
            </Button>
          </>
        }
      >
        <Field label="文件夹名称" hint="相对于当前所在目录，可用 / 创建多级目录。">
          <Input
            value={newFolder ?? ''}
            autoFocus
            placeholder="文件夹名称"
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNewFolder();
            }}
          />
        </Field>
      </Modal>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="重命名"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button disabled={busy || !(renaming?.name ?? '').trim()} onClick={() => void submitRename()}>
              保存
            </Button>
          </>
        }
      >
        <Field label="名称" hint={renaming ? `原名称：${renaming.entry.name}` : undefined}>
          <Input
            value={renaming?.name ?? ''}
            autoFocus
            placeholder="新名称"
            onChange={(e) => setRenaming((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRename();
            }}
          />
        </Field>
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="删除确认"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => confirm && void submitDelete(confirm)}>
              删除
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {confirm
            ? confirm.length === 1
              ? `确定删除${confirm[0].kind === 'folder' ? '文件夹（含其下全部内容）' : '文件'}「${confirm[0].name}」？`
              : `确定删除选中的 ${confirm.length} 项？（含文件夹及其全部内容）`
            : ''}
        </p>
      </Modal>
    </div>
  );
}

function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-accent ${danger ? 'text-destructive' : 'text-foreground'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
