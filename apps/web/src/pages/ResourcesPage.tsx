import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

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

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.6 1.8h9.2A1.5 1.5 0 0 1 21 8.3v9.2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.5 3h7.2L19 8.3V20a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm6.7 1.6V9h4.4l-4.4-4.4z" />
    </svg>
  );
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
          ? 'bg-blue-100 ring-1 ring-blue-400'
          : isCurrent
            ? 'bg-blue-50'
            : 'hover:bg-slate-100';
        return (
          <div key={node.path}>
            <div
              className={`flex items-center gap-1 rounded px-1 py-0.5 ${rowClass}`}
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
                className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(node.path);
                }}
              >
                {node.children.length > 0 ? (isOpen ? '▾' : '▸') : ''}
              </button>
              <FolderIcon className="h-4 w-4 shrink-0 text-amber-400" />
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
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
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

  async function submitRename(entry: ResourceEntry): Promise<void> {
    const name = renaming?.name.trim();
    if (!name || name === entry.name) {
      setRenaming(null);
      return;
    }
    const url = entry.kind === 'folder' ? '/api/resources/folders' : '/api/resources/files';
    const ok = await run(() => api.request('PATCH', url, { body: { path: entry.path, name } }));
    if (ok) setRenaming(null);
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
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">资源管理</h1>
        <span className="text-xs text-slate-400">
          Cmd/Ctrl+单击多选，Shift 区间选择{selected.size > 0 ? `；已选 ${selected.size} 项` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded border text-sm">
            <button
              className={`px-2 py-1 ${view === 'grid' ? 'bg-slate-200 text-slate-800' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setView('grid')}
            >
              图标
            </button>
            <button
              className={`px-2 py-1 ${view === 'list' ? 'bg-slate-200 text-slate-800' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setView('list')}
            >
              列表
            </button>
          </div>
          <button
            className="rounded border px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            disabled={busy}
            onClick={() => setNewFolder(newFolder === null ? '' : null)}
          >
            新建文件夹
          </button>
          <button
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            上传 csv / excel
          </button>
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
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {confirm && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm">
          <span className="text-red-700">
            {confirm.length === 1
              ? `确定删除${confirm[0].kind === 'folder' ? '文件夹（含其下全部内容）' : '文件'}「${confirm[0].name}」？`
              : `确定删除选中的 ${confirm.length} 项？（含文件夹及其全部内容）`}
          </span>
          <button
            className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => void submitDelete(confirm)}
          >
            删除
          </button>
          <button
            className="rounded border px-3 py-1 text-slate-600 hover:bg-white disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            取消
          </button>
        </div>
      )}

      {newFolder !== null && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitNewFolder();
          }}
        >
          <input
            className="w-72 border px-2 py-1 text-sm"
            placeholder="文件夹名称（可用 / 创建多级目录）"
            value={newFolder}
            autoFocus
            onChange={(e) => setNewFolder(e.target.value)}
          />
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={busy || !newFolder.trim()}
          >
            创建
          </button>
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm text-slate-600 disabled:opacity-50"
            disabled={busy}
            onClick={() => setNewFolder(null)}
          >
            取消
          </button>
        </form>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="w-56 shrink-0 overflow-auto rounded border bg-white p-2 text-sm">
          <div
            className={`flex items-center gap-1 rounded px-1 py-0.5 ${
              rootOver ? 'bg-blue-100 ring-1 ring-blue-400' : path === '' ? 'bg-blue-50' : 'hover:bg-slate-100'
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
            <FolderIcon className="h-4 w-4 shrink-0 text-amber-400" />
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
        </aside>

        <main className="flex min-h-0 flex-1 flex-col rounded border bg-white">
          <nav className="flex flex-wrap items-center gap-1 border-b px-3 py-2 text-sm">
            <button
              className={`rounded px-1 hover:bg-slate-100 ${rootOver ? 'ring-1 ring-blue-400' : ''}`}
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
                  <span className="text-slate-400">/</span>
                  {i === crumbs.length - 1 ? (
                    <span className="px-1 text-slate-700">{seg}</span>
                  ) : (
                    <button
                      className="rounded px-1 text-blue-600 hover:bg-slate-100"
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

          <div
            className={`min-h-0 flex-1 overflow-auto p-3 ${bgOver ? 'bg-blue-50' : ''}`}
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
            {entries.length === 0 && <p className="text-sm text-slate-500">此目录为空。</p>}

            {view === 'grid' ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-1">
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
                      className={`flex cursor-default select-none flex-col items-center gap-1 rounded border p-2 text-center ${
                        isOver
                          ? 'border-blue-400 bg-blue-100'
                          : isSel
                            ? 'border-blue-400 bg-blue-50'
                            : 'border-transparent hover:bg-slate-100'
                      }`}
                    >
                      {entry.kind === 'folder' ? (
                        <FolderIcon className="h-10 w-10 text-amber-400" />
                      ) : (
                        <FileIcon className="h-10 w-10 text-emerald-500" />
                      )}
                      {renaming?.path === entry.path ? (
                        <input
                          className="w-full border px-1 py-0.5 text-center text-xs"
                          value={renaming.name}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenaming({ path: entry.path, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitRename(entry);
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => void submitRename(entry)}
                        />
                      ) : (
                        <span className="line-clamp-2 w-full break-all text-xs">
                          {entry.name}
                          {entry.kind === 'file' && (
                            <span className="block text-[10px] text-slate-400">{formatSize(entry.size)}</span>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="divide-y">
                <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-slate-500">
                  <span className="flex-1">名称</span>
                  <span className="w-20 text-right">大小</span>
                  <span className="w-40 text-right">修改时间</span>
                </div>
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
                      className={`flex cursor-default select-none items-center gap-2 px-2 py-1 text-sm ${
                        isOver ? 'bg-blue-100 ring-1 ring-inset ring-blue-400' : isSel ? 'bg-blue-50' : 'hover:bg-slate-100'
                      }`}
                    >
                      {entry.kind === 'folder' ? (
                        <FolderIcon className="h-4 w-4 shrink-0 text-amber-400" />
                      ) : (
                        <FileIcon className="h-4 w-4 shrink-0 text-emerald-500" />
                      )}
                      {renaming?.path === entry.path ? (
                        <input
                          className="flex-1 border px-1 py-0.5 text-sm"
                          value={renaming.name}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenaming({ path: entry.path, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitRename(entry);
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => void submitRename(entry)}
                        />
                      ) : (
                        <span className="flex-1 truncate">{entry.name}</span>
                      )}
                      <span className="w-20 text-right text-xs text-slate-400">
                        {entry.kind === 'file' ? formatSize(entry.size) : ''}
                      </span>
                      <span className="w-40 text-right text-xs text-slate-400">
                        {entry.kind === 'file' ? formatTime(entry.mtime) : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-40 overflow-hidden rounded border bg-white py-1 text-sm shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.entry === null ? (
            <>
              <MenuItem
                label="新建文件夹"
                onClick={() => setNewFolder('')}
              />
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
                      onClick={() => setRenaming({ path: entry.path, name: entry.name })}
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
    </div>
  );
}

function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      className={`block w-full px-3 py-1 text-left hover:bg-slate-100 ${danger ? 'text-red-600' : 'text-slate-700'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
