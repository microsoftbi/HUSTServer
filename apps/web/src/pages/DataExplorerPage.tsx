import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  Eye,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Table2,
  Terminal,
} from 'lucide-react';
import { api, ApiClientError } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardHeader, CardTitle } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Field, Input, Select } from '../components/ui/input.js';
import { PageHeader } from '../components/ui/page-header.js';
import { DataTable } from '@bi/components/DataTable';
import type { CellValue } from '@bi/types';

// Monaco 体积较大，懒加载以免拖慢首屏。
const SqlEditor = lazy(() =>
  import('../components/sql-editor.js').then((m) => ({ default: m.SqlEditor })),
);

type SourceType = 'connection' | 'model';

interface ConnectionOption {
  id: string;
  name: string;
}

interface TableInfo {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface ModelOption {
  name: string;
  rowCount: number;
  columns: ColumnInfo[];
}

interface QueryResult {
  columns: ColumnInfo[];
  rows: CellValue[][];
  truncated: boolean;
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

function tableKey(t: TableInfo): string {
  return `${t.schema}.${t.name}`;
}

/** 数据探索：左侧浏览表/视图与列，右侧编写并执行只读 SQL。 */
export function DataExplorerPage() {
  const [sourceType, setSourceType] = useState<SourceType>('connection');
  const [reloadToken, setReloadToken] = useState(0);

  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  /** 已正式连接的连接 id：只有点「连接」后才去连库，避免仅选中就自动连接 */
  const [connectedId, setConnectedId] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [listError, setListError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [columnsCache, setColumnsCache] = useState<Record<string, ColumnInfo[]>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());

  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  /** 清空左侧展开态与上次查询结果（切换数据源时调用）。 */
  const resetExplorer = useCallback(() => {
    setExpanded(new Set());
    setColumnsCache({});
    setLoadingKeys(new Set());
    setResult(null);
    setElapsedMs(null);
    setQueryError(null);
  }, []);

  // 加载数据源候选：连接模式取连接列表，模型模式取模型清单（含列信息）。
  useEffect(() => {
    if (sourceType === 'connection') {
      void (async () => {
        try {
          const list = await api.get<ConnectionOption[]>('/api/connections');
          setConnections(list);
          setSelectedConnectionId((cur) => (list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? '')));
          setListError(null);
        } catch (err) {
          setConnections([]);
          setSelectedConnectionId('');
          setListError(errText(err));
        }
      })();
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    void (async () => {
      try {
        const res = await api.get<{ items: ModelOption[] }>('/api/explore/models');
        if (cancelled) return;
        setModels(res.items);
        setSelectedModel((cur) => (res.items.some((m) => m.name === cur) ? cur : (res.items[0]?.name ?? '')));
        setListError(null);
      } catch (err) {
        if (cancelled) return;
        setModels([]);
        setSelectedModel('');
        setListError(errText(err));
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceType, reloadToken]);

  // 连接模式：点「连接」后才拉取库中的表/视图（选中连接不触发连库）。
  useEffect(() => {
    if (sourceType !== 'connection' || !connectedId) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setTablesLoading(true);
    void (async () => {
      try {
        const res = await api.post<{ tables: TableInfo[] }>('/api/data/tables', {
          body: { connectionId: connectedId },
        });
        if (cancelled) return;
        setTables(res.tables);
        setListError(null);
      } catch (err) {
        if (cancelled) return;
        setTables([]);
        setListError(errText(err));
      } finally {
        if (!cancelled) setTablesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceType, connectedId, reloadToken]);

  /** 加载某张表/视图的列信息（按 key 缓存）。 */
  async function loadColumns(t: TableInfo): Promise<void> {
    const key = tableKey(t);
    setLoadingKeys((prev) => new Set(prev).add(key));
    try {
      const res = await api.post<{ columns: ColumnInfo[] }>('/api/explore/columns', {
        body: { connectionId: connectedId, schema: t.schema, name: t.name },
      });
      setColumnsCache((prev) => ({ ...prev, [key]: res.columns }));
    } catch (err) {
      setListError(errText(err));
    } finally {
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /** 点击表/视图：展开并填入默认 SQL；再次点击收起。 */
  function onTableClick(t: TableInfo): void {
    const key = tableKey(t);
    if (expanded.has(key)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpanded((prev) => new Set(prev).add(key));
    setSql(`SELECT TOP 100 * FROM [${t.schema}].[${t.name}]`);
    if (!columnsCache[key] && !loadingKeys.has(key)) void loadColumns(t);
  }

  /** 点击模型：展开其列（数据已在手）并填入默认 SQL；再次点击收起。 */
  function onModelClick(m: ModelOption): void {
    const key = `model:${m.name}`;
    if (expanded.has(key)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpanded((prev) => new Set(prev).add(key));
    setSql(`SELECT * FROM ${m.name} LIMIT 100`);
  }

  function switchSourceType(next: SourceType): void {
    if (next === sourceType) return;
    setSourceType(next);
    setSearch('');
    setSql('');
    setConnectedId('');
    resetExplorer();
  }

  /** 选中连接：只记录选择，等用户点「连接」后才真正连库。 */
  function switchConnection(id: string): void {
    setSelectedConnectionId(id);
    setSql('');
    setConnectedId('');
    resetExplorer();
  }

  /** 正式连接：拉取该连接下的表/视图；已连接时再次点击表示重新加载。 */
  function connect(): void {
    if (!selectedConnectionId) return;
    resetExplorer();
    if (connectedId === selectedConnectionId) {
      setReloadToken((t) => t + 1);
      return;
    }
    setConnectedId(selectedConnectionId);
  }

  function switchModel(name: string): void {
    setSelectedModel(name);
    setSql('');
    resetExplorer();
  }

  function refresh(): void {
    setReloadToken((t) => t + 1);
    resetExplorer();
  }

  const run = useCallback(async () => {
    const sqlText = sql.trim();
    if (!sqlText) {
      setQueryError('请输入 SQL 语句');
      setResult(null);
      return;
    }
    if (sourceType === 'connection' && !connectedId) {
      setQueryError('请先选择数据连接并点击「连接」');
      setResult(null);
      return;
    }
    setRunning(true);
    setQueryError(null);
    const started = performance.now();
    try {
      const body =
        sourceType === 'connection'
          ? { source: 'connection' as const, connectionId: connectedId, sql: sqlText }
          : { source: 'model' as const, sql: sqlText };
      const res = await api.post<QueryResult>('/api/explore/query', { body });
      setResult(res);
      setElapsedMs(Math.round(performance.now() - started));
    } catch (err) {
      setResult(null);
      setElapsedMs(null);
      setQueryError(errText(err));
    } finally {
      setRunning(false);
    }
  }, [sql, sourceType, connectedId]);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(query))
      : tables;
    const map = new Map<string, TableInfo[]>();
    for (const t of filtered) {
      const arr = map.get(t.schema);
      if (arr) arr.push(t);
      else map.set(t.schema, [t]);
    }
    return [...map.entries()];
  }, [tables, search]);

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? models.filter((m) => m.name.toLowerCase().includes(query)) : models;
  }, [models, search]);

  const refreshing = tablesLoading || modelsLoading;

  return (
    <div className="space-y-4">
      <PageHeader
        title="数据探索"
        description="选择数据连接或数据模型，浏览表与视图结构，编写只读 SQL 查询数据（仅支持 SELECT / WITH）。"
      >
        <Button variant="outline" disabled={refreshing} onClick={refresh}>
          <RefreshCw />
          {refreshing ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      {listError && <ErrorNote>{listError}</ErrorNote>}

      <div className="flex flex-wrap items-end gap-4">
        <Field label="数据源类型" className="w-auto">
          <div className="flex gap-1 rounded-md bg-muted p-1">
            <Button
              type="button"
              size="sm"
              variant={sourceType === 'connection' ? 'secondary' : 'ghost'}
              onClick={() => switchSourceType('connection')}
            >
              连接
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sourceType === 'model' ? 'secondary' : 'ghost'}
              onClick={() => switchSourceType('model')}
            >
              数据模型
            </Button>
          </div>
        </Field>

        <Field label="数据源" className="w-72">
          {sourceType === 'connection' ? (
            <Select
              value={selectedConnectionId}
              onChange={(e) => switchConnection(e.target.value)}
              disabled={connections.length === 0}
            >
              {connections.length === 0 && <option value="">暂无可用连接</option>}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <Select
              value={selectedModel}
              onChange={(e) => switchModel(e.target.value)}
              disabled={models.length === 0}
            >
              {models.length === 0 && <option value="">暂无数据模型</option>}
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {sourceType === 'connection' ? (
          <Button
            type="button"
            disabled={!selectedConnectionId || tablesLoading}
            onClick={connect}
          >
            {tablesLoading
              ? '连接中…'
              : connectedId && connectedId === selectedConnectionId
                ? '重新连接'
                : '连接'}
          </Button>
        ) : null}
      </div>

      <div className="flex h-[calc(100vh-15rem)] min-h-0 gap-4">
        <Card className="flex w-56 shrink-0 flex-col overflow-hidden">
          <CardHeader>
            <CardTitle>{sourceType === 'connection' ? '表 / 视图' : '数据模型'}</CardTitle>
            <Columns3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <div className="border-b border-border/70 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索名称…"
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2 text-sm">
            {sourceType === 'connection' ? (
              tablesLoading ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</p>
              ) : tables.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {!selectedConnectionId
                    ? '请先选择数据连接'
                    : !connectedId
                      ? '点击「连接」加载表与视图'
                      : '未发现表或视图'}
                </p>
              ) : groups.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">无匹配结果</p>
              ) : (
                groups.map(([schema, list]) => (
                  <div key={schema} className="mb-2">
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{schema}</div>
                    {list.map((t) => (
                      <TableRowItem
                        key={tableKey(t)}
                        table={t}
                        open={expanded.has(tableKey(t))}
                        loading={loadingKeys.has(tableKey(t))}
                        columns={columnsCache[tableKey(t)]}
                        onClick={() => onTableClick(t)}
                      />
                    ))}
                  </div>
                ))
              )
            ) : modelsLoading ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</p>
            ) : models.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">暂无数据模型</p>
            ) : filteredModels.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">无匹配结果</p>
            ) : (
              filteredModels.map((m) => {
                const key = `model:${m.name}`;
                const open = expanded.has(key);
                return (
                  <div key={key}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent"
                      onClick={() => onModelClick(m)}
                    >
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{m.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{m.rowCount} 行</span>
                    </button>
                    {open && <ColumnList columns={m.columns} />}
                  </div>
                );
              })
            )}
          </div>
        </Card>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <Card className="flex shrink-0 flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>SQL 编辑器</CardTitle>
              <Button size="sm" disabled={running} onClick={() => void run()}>
                <Play />
                {running ? '运行中…' : '运行'}
              </Button>
            </CardHeader>
            <div className="p-4">
              <Suspense
                fallback={
                  <div className="flex h-[200px] items-center justify-center rounded-md border border-border text-sm text-muted-foreground">
                    编辑器加载中…
                  </div>
                }
              >
                <SqlEditor
                  value={sql}
                  onChange={setSql}
                  height={200}
                  onRun={() => void run()}
                  placeholder="SELECT ..."
                />
              </Suspense>
              <p className="mt-2 text-xs text-muted-foreground">
                仅支持只读查询（SELECT / WITH），可按 Ctrl / Cmd + Enter 运行。
              </p>
            </div>
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>查询结果</CardTitle>
              {result && (
                <span className="text-xs text-muted-foreground">
                  {result.rows.length} 行 · {result.columns.length} 列
                  {result.truncated ? `（结果已截断，仅显示前 ${result.rows.length} 行）` : ''}
                  {elapsedMs !== null ? ` · 耗时 ${elapsedMs} ms` : ''}
                </span>
              )}
            </CardHeader>
            <div className="min-h-0 min-w-0 flex-1 p-4">
              {queryError ? (
                <ErrorNote>{queryError}</ErrorNote>
              ) : result ? (
                <DataTable columns={result.columns} rows={result.rows} />
              ) : running ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  查询中…
                </div>
              ) : (
                <EmptyState
                  icon={Terminal}
                  title="暂无查询结果"
                  description="编写 SQL 后点击运行查看结果。"
                />
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** 左栏单张表/视图：可展开显示列。 */
function TableRowItem({
  table,
  open,
  loading,
  columns,
  onClick,
}: {
  table: TableInfo;
  open: boolean;
  loading: boolean;
  columns: ColumnInfo[] | undefined;
  onClick: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent"
        onClick={onClick}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {table.type === 'view' ? (
          <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate">{table.name}</span>
        {table.type === 'view' && (
          <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[10px]">
            视图
          </Badge>
        )}
      </button>
      {open && (loading ? <p className="ml-5 py-1 text-xs text-muted-foreground">加载中…</p> : <ColumnList columns={columns} />)}
    </div>
  );
}

/** 列清单：列名 + 灰色类型小字。 */
function ColumnList({ columns }: { columns: ColumnInfo[] | undefined }) {
  if (!columns) return null;
  if (columns.length === 0) return <p className="ml-5 py-1 text-xs text-muted-foreground">无列信息</p>;
  return (
    <ul className="mb-1 ml-5 space-y-0.5 border-l border-border pl-2">
      {columns.map((c, i) => (
        <li key={`${c.name}-${i}`} className="flex items-center gap-2 py-0.5">
          <span className="flex-1 truncate">{c.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{c.type}</span>
        </li>
      ))}
    </ul>
  );
}
