import { useEffect, useMemo, useState } from 'react';
import { Check, Filter, FilterX, Loader2, RefreshCw, TableProperties } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkflowStore } from '@/store/workflowStore';
import { formatCell, formatDuration, formatInt } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 每列的筛选状态：列名 → 该列已勾选的值集合（NULL 用空串表示）。 */
type ColumnFilters = Record<string, Set<string>>;

/** 阶段数据预览：展示运行后缓存中当前节点的输出。 */
export function DataPreview({ nodeId }: { nodeId: string }) {
  const status = useWorkflowStore((s) => s.nodeStatus[nodeId]);
  const result = useWorkflowStore((s) => s.nodeResults[nodeId]);
  const entry = useWorkflowStore((s) => s.previews[nodeId]);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const loadPreview = useWorkflowStore((s) => s.loadPreview);

  const data = entry?.data;
  const canPreview = runStatus === 'success' && status === 'success';

  const [filters, setFilters] = useState<ColumnFilters>({});

  // 切换节点或重新加载数据时清空筛选（列结构与值可能已变化）
  useEffect(() => {
    setFilters({});
  }, [nodeId, data]);

  // 切换节点时按需加载其运行后缓存的预览数据
  useEffect(() => {
    const state = useWorkflowStore.getState();
    if (
      state.runStatus === 'success' &&
      state.nodeStatus[nodeId] === 'success' &&
      !state.previews[nodeId]
    ) {
      void state.loadPreview(nodeId);
    }
  }, [nodeId, runStatus]);

  // 每列的去重值（按展示文本升序），供筛选菜单枚举
  const columnValues = useMemo(() => {
    const map: Record<string, string[]> = {};
    if (!data) return map;
    for (const column of data.columns) {
      const set = new Set<string>();
      for (const row of data.rows) set.add(formatCell(row[column.name]));
      map[column.name] = [...set].sort((a, b) => displayValue(a).localeCompare(displayValue(b), 'zh-CN'));
    }
    return map;
  }, [data]);

  // 某列已勾选的值；尚未建立筛选状态时视为全选
  const selectedFor = (column: string) => filters[column] ?? new Set(columnValues[column] ?? []);

  // 已生效筛选的列（勾选数少于该列全部去重值，即真正在过滤）
  const activeColumns = useMemo(
    () =>
      Object.keys(filters).filter((column) => {
        const selected = filters[column];
        const total = columnValues[column]?.length ?? 0;
        return Boolean(selected) && selected.size < total;
      }),
    [filters, columnValues],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    if (activeColumns.length === 0) return data.rows;
    return data.rows.filter((row) =>
      activeColumns.every((column) => filters[column]?.has(formatCell(row[column]))),
    );
  }, [data, activeColumns, filters]);

  const setColumnSelection = (column: string, next: Set<string>) => {
    setFilters((prev) => ({ ...prev, [column]: next }));
  };

  const toggleValue = (column: string, value: string) => {
    const next = new Set(selectedFor(column));
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setColumnSelection(column, next);
  };

  const setColumnAll = (column: string, select: boolean) => {
    setColumnSelection(column, new Set(select ? (columnValues[column] ?? []) : []));
  };

  const hasActiveFilter = activeColumns.length > 0;

  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={!canPreview || entry?.loading}
      onClick={() => void loadPreview(nodeId)}
    >
      {entry?.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      刷新
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {result ? `${formatInt(result.rowCount)} 行 · ${formatDuration(result.durationMs)}` : '暂无运行结果'}
        </span>
        {data?.truncated && (
          <Badge variant="warning">
            仅显示前 {formatInt(data.rows.length)} / {formatInt(data.totalRows)} 行
          </Badge>
        )}
        {hasActiveFilter && (
          <>
            <span className="text-[11px] text-primary">
              筛选后 {formatInt(filteredRows.length)} / {formatInt(data?.rows.length ?? 0)} 行
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setFilters({})}>
              <FilterX />
              清除筛选
            </Button>
          </>
        )}
        <div className="ml-auto">{refreshButton}</div>
      </div>

      <div className="min-h-0 flex-1">
        {status === 'error' ? (
          <StateBlock tone="error" title="该阶段运行失败" detail={result?.error} />
        ) : !runStatus || runStatus === 'idle' ? (
          <StateBlock title="尚未运行" detail="点击右上角「运行」后即可查看各阶段输出数据。" />
        ) : status === 'running' || status === 'pending' ? (
          <StateBlock title="等待运行完成" detail="该阶段正在执行或被上游阻塞。" />
        ) : entry?.loading ? (
          <StateBlock title="加载中…" />
        ) : entry?.error ? (
          <StateBlock tone="error" title="预览加载失败" detail={entry.error} />
        ) : !data ? (
          <StateBlock title="暂无数据" detail="该阶段可能没有输出行。" />
        ) : data.rows.length === 0 ? (
          <StateBlock title="空结果集" detail={`共 ${formatInt(data.totalRows)} 行`} />
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                {data.columns.map((column) => {
                  const values = columnValues[column.name] ?? [];
                  const selected = selectedFor(column.name);
                  return (
                    <TableHead key={column.name} className="whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <span className="text-foreground">{column.name}</span>
                        <span className="text-[9px] text-muted-foreground/70">{column.type}</span>
                        <ColumnFilterMenu
                          values={values}
                          selected={selected}
                          active={selected.size < values.length}
                          onToggle={(value) => toggleValue(column.name, value)}
                          onSelectAll={(select) => setColumnAll(column.name, select)}
                        />
                      </div>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {data.columns.map((column) => {
                    const text = formatCell(row[column.name]);
                    return (
                      <TableCell
                        key={column.name}
                        title={text}
                        className="max-w-[240px] truncate whitespace-nowrap text-xs"
                      >
                        {text || <span className="text-muted-foreground/50">NULL</span>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {filteredRows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={data.columns.length}
                    className="py-6 text-center text-xs text-muted-foreground"
                  >
                    无匹配当前筛选条件的行
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

/** NULL（空串）在枚举列表与搜索中统一显示为 NULL。 */
function displayValue(value: string): string {
  return value === '' ? 'NULL' : value;
}

/** 列头筛选菜单：搜索 + 枚举值勾选，勾选后菜单保持打开以便连续多选。 */
function ColumnFilterMenu({
  values,
  selected,
  active,
  onToggle,
  onSelectAll,
}: {
  values: string[];
  selected: Set<string>;
  active: boolean;
  onToggle: (value: string) => void;
  onSelectAll: (select: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const keyword = search.trim().toLowerCase();
  const candidates = keyword
    ? values.filter((value) => displayValue(value).toLowerCase().includes(keyword))
    : values;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="筛选该列"
          className={cn(
            'rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground',
            active && 'text-primary hover:text-primary',
          )}
        >
          <Filter className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="p-1">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="搜索值…"
            className="h-7 text-xs"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-between px-2 py-0.5 text-[11px]">
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onSelectAll(true)}
          >
            全选
          </button>
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onSelectAll(false)}
          >
            清空
          </button>
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-56 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">无匹配值</div>
          ) : (
            candidates.map((value) => (
              <DropdownMenuItem
                key={value || '__null__'}
                onSelect={(event) => {
                  event.preventDefault();
                  onToggle(value);
                }}
                className="gap-2"
              >
                <span className="flex size-3.5 items-center justify-center">
                  {selected.has(value) && <Check className="text-primary" />}
                </span>
                <span className="truncate">{displayValue(value)}</span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StateBlock({
  title,
  detail,
  tone = 'default',
}: {
  title: string;
  detail?: string;
  tone?: 'default' | 'error';
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <TableProperties className="size-6 text-muted-foreground/60" />
      <div className={tone === 'error' ? 'text-sm font-medium text-destructive' : 'text-sm font-medium'}>
        {title}
      </div>
      {detail && (
        <div className={tone === 'error' ? 'text-xs text-destructive/80' : 'text-xs text-muted-foreground'}>
          {detail}
        </div>
      )}
    </div>
  );
}
