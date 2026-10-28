import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { ArrowLeft, Database, Eye, LayoutDashboard, Pencil, RefreshCw, Save } from 'lucide-react';
import { api, ApiClientError } from '../../api.js';
import { useAuth } from '../../auth.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { UnsavedChangesDialog } from '../../components/ui/unsaved-changes-dialog.js';
import { DashboardView } from './DashboardView';
import { DataView } from './DataView';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip';
import { cn } from './lib/utils';
import { hydrateDataset } from './services/dataSource';
import { useDashboardStore } from './stores/dashboardStore';
import { useDatasetStore } from './stores/datasetStore';
import type {
  Dashboard,
  DashboardPayload,
  Dataset,
  FilterCondition,
  SavedDataset,
} from './types';

type ViewKey = 'dashboard' | 'data';

const NAV_ITEMS: Array<{ key: ViewKey; label: string; Icon: typeof Database }> = [
  { key: 'dashboard', label: '仪表板', Icon: LayoutDashboard },
  { key: 'data', label: '数据', Icon: Database },
];

/** 组装落库 payload：以最近一次服务端状态为底，合并当前运行时数据集定义 */
function composePayload(
  state: {
    dashboards: Dashboard[];
    activeId: string;
    reportFilters: FilterCondition[];
    syncSlicers: boolean;
  },
  runtime: Dataset[],
  previous: DashboardPayload | null,
): DashboardPayload {
  const merged = new Map<string, SavedDataset>((previous?.datasets ?? []).map((d) => [d.id, d]));
  for (const ds of runtime) {
    merged.set(ds.id, {
      id: ds.id,
      name: ds.name,
      def: ds.def,
      formats: ds.formats,
      measures: ds.measures,
    });
  }
  return {
    version: 2,
    dashboards: state.dashboards,
    activeId: state.activeId,
    datasets: [...merged.values()],
    filters: state.reportFilters,
    syncSlicers: state.syncSlicers,
  };
}

/** 稳定的比较键：数据集按 id 排序，避免加载顺序不同导致「未保存」误判 */
function payloadKey(payload: DashboardPayload): string {
  return JSON.stringify({
    ...payload,
    datasets: [...payload.datasets]
      .map((d) => ({ id: d.id, name: d.name, def: d.def, formats: d.formats, measures: d.measures }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    filters: payload.filters ?? [],
    syncSlicers: !!payload.syncSlicers,
  });
}

export function DashboardEditorPage({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasCap } = useAuth();
  const canEditCap = hasCap('dashboard.edit');
  const canEdit = canEditCap && !readOnly;
  const [rowName, setRowName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('dashboard');
  /** 服务端最近一次已知状态：保存时作为 datasets 合并的底（保留失败/未 hydrate 数据集的定义） */
  const loadedRef = useRef<DashboardPayload | null>(null);
  /** 最近一次加载 / 保存时的 payload 比较键，用于判断是否有未保存更改 */
  const [baseline, setBaseline] = useState<string | null>(null);
  /** 待离开的目标地址：存在时展示未保存确认对话框 */
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const reportFilters = useDashboardStore((s) => s.reportFilters);
  const syncSlicers = useDashboardStore((s) => s.syncSlicers);
  const errors = useDatasetStore((s) => s.errors);
  const datasets = useDatasetStore((s) => s.datasets);
  const refreshing = useDatasetStore((s) => s.refreshing);
  const refreshingAny = Object.keys(refreshing).length > 0;
  /** 自动刷新间隔（分钟），0 表示关闭 */
  const [refreshMinutes, setRefreshMinutes] = useState(0);

  /** 数据新鲜度：取最早一次取数时间，反映最旧的数据集 */
  const fetchedAt = useMemo(() => {
    const times = datasets
      .map((d) => Date.parse(d.fetchedAt ?? d.createdAt))
      .filter((t) => Number.isFinite(t));
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  }, [datasets]);

  const refreshAll = useCallback(async () => {
    const { ok, failed } = await useDatasetStore.getState().refreshAll();
    if (failed > 0) toast.error(`有 ${failed} 个数据集刷新失败，已保留上次数据`);
    else if (ok > 0) toast.success(`已刷新 ${ok} 个数据集`);
  }, []);

  // 自动刷新间隔按仪表板落 localStorage（不写入报表定义）
  useEffect(() => {
    if (!id) return;
    const saved = Number(window.localStorage.getItem(`hustserver.dashboard.refresh.${id}`));
    setRefreshMinutes([1, 5, 15].includes(saved) ? saved : 0);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    window.localStorage.setItem(`hustserver.dashboard.refresh.${id}`, String(refreshMinutes));
  }, [id, refreshMinutes]);

  useEffect(() => {
    if (!refreshMinutes) return;
    const timer = window.setInterval(() => void refreshAll(), refreshMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshMinutes, refreshAll]);

  const save = useCallback(
    async (options: { silent?: boolean } = {}): Promise<boolean> => {
      if (!id || readOnly) return false;
      try {
        setSaving(true);
        const dash = useDashboardStore.getState();
        const data = useDatasetStore.getState();
        const payload = composePayload(
          {
            dashboards: dash.dashboards,
            activeId: dash.activeId,
            reportFilters: dash.reportFilters,
            syncSlicers: dash.syncSlicers,
          },
          data.datasets,
          loadedRef.current,
        );
        await api.put(`/api/dashboards/${id}`, { body: { payload } });
        loadedRef.current = payload;
        setBaseline(payloadKey(payload));
        setSavedAt(new Date().toLocaleTimeString());
        if (!options.silent) window.alert('保存成功');
        return true;
      } catch (err) {
        const msg = err instanceof ApiClientError ? `${err.message}${err.detail ? `（${err.detail}）` : ''}` : (err as Error).message;
        toast.error(`保存失败：${msg}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [id, readOnly],
  );

  /** 当前编辑内容是否与服务端最近一次状态不一致（只读页不提示） */
  const dirty = useMemo(() => {
    if (!canEdit || baseline === null || !loadedRef.current) return false;
    const payload = composePayload(
      { dashboards, activeId, reportFilters, syncSlicers },
      datasets,
      loadedRef.current,
    );
    return payloadKey(payload) !== baseline;
  }, [canEdit, baseline, dashboards, activeId, reportFilters, syncSlicers, datasets]);

  // 未保存时刷新 / 关闭页面给出浏览器原生提示
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /** 链接式离开：有未保存更改时先弹确认，不直接跳转 */
  function guardLeave(event: MouseEvent, to: string): void {
    if (!dirty) return;
    event.preventDefault();
    setPendingPath(to);
  }

  async function saveAndLeave(): Promise<void> {
    if (!pendingPath) return;
    const target = pendingPath;
    if (await save({ silent: true })) {
      setPendingPath(null);
      navigate(target);
    }
  }

  function discardAndLeave(): void {
    const target = pendingPath;
    setPendingPath(null);
    if (target) navigate(target);
  }

  // 加载：payload → stores → 并行 hydrate 数据集
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      useDashboardStore.getState().reset();
      useDatasetStore.getState().reset();
      try {
        const row = await api.get<{ id: string; name: string; payload: DashboardPayload }>(`/api/dashboards/${id}`);
        if (cancelled) return;
        setRowName(row.name);
        loadedRef.current = row.payload;
        useDashboardStore.getState().setDashboards(row.payload.dashboards);
        useDashboardStore.getState().setActive(row.payload.activeId);
        useDashboardStore.getState().setReportFilters(row.payload.filters ?? []);
        useDashboardStore.getState().setSyncSlicers(!!row.payload.syncSlicers);
        // 加载完成即为「已保存」基线，之后的编辑都会与之比对
        setBaseline(payloadKey(row.payload));
        await Promise.all(
          row.payload.datasets.map(async (saved) => {
            try {
              const ds = await hydrateDataset(saved);
              if (cancelled) return;
              useDatasetStore.getState().addDataset(ds);
              useDatasetStore.getState().clearError(saved.id);
            } catch (err) {
              if (cancelled) return;
              useDatasetStore.getState().setError(saved.id, (err as Error).message);
            }
          }),
        );
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Ctrl/Cmd+S 保存
  useEffect(() => {
    if (readOnly) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, readOnly]);

  async function retry(savedId: string) {
    const saved = loadedRef.current?.datasets.find((d) => d.id === savedId);
    if (!saved) return;
    try {
      const ds = await hydrateDataset(saved);
      useDatasetStore.getState().addDataset(ds);
      useDatasetStore.getState().clearError(savedId);
      toast.success(`数据集「${saved.name}」已重新取数`);
    } catch (err) {
      useDatasetStore.getState().setError(savedId, (err as Error).message);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-muted/40">
        <p className="text-sm text-destructive">加载失败：{loadError}</p>
        <Button asChild variant="outline">
          <Link to="/dashboards">返回列表</Link>
        </Button>
      </div>
    );
  }

  const errorEntries = Object.entries(errors);

  return (
    <div className="flex h-screen flex-col bg-muted/40">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboards" onClick={(e) => guardLeave(e, '/dashboards')}>
            <ArrowLeft />
            返回列表
          </Link>
        </Button>
        <span className="font-medium">{rowName || '仪表板'}</span>
        {dirty && <Badge tone="warning">未保存</Badge>}
        {savedAt && <span className="text-xs text-muted-foreground">已保存于 {savedAt}</span>}
        <div className="ml-auto flex items-center gap-2">
          {fetchedAt && (
            <span className="text-xs text-muted-foreground" title="最早一次取数时间">
              数据更新于 {fetchedAt.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={refreshingAny || datasets.length === 0}
            onClick={() => void refreshAll()}
          >
            <RefreshCw className={cn(refreshingAny && 'animate-spin')} />
            {refreshingAny ? '刷新中…' : '刷新'}
          </Button>
          <select
            aria-label="自动刷新间隔"
            title="自动刷新间隔"
            value={refreshMinutes}
            onChange={(e) => setRefreshMinutes(Number(e.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value={0}>不自动刷新</option>
            <option value={1}>每 1 分钟</option>
            <option value={5}>每 5 分钟</option>
            <option value={15}>每 15 分钟</option>
          </select>
          {readOnly && canEditCap && (
            <Button asChild>
              <Link to={`/dashboards/${id}`}>
                <Pencil />
                编辑
              </Link>
            </Button>
          )}
          {!readOnly && id && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link
                  to={`/dashboards/${id}/preview`}
                  onClick={(e) => guardLeave(e, `/dashboards/${id}/preview`)}
                >
                  <Eye />
                  预览
                </Link>
              </Button>
              {canEdit && (
                <Button disabled={saving} onClick={() => void save()}>
                  <Save />
                  {saving ? '保存中…' : '保存'}
                </Button>
              )}
            </>
          )}
        </div>
      </header>
      {errorEntries.length > 0 && (
        <div className="shrink-0 space-y-1 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {errorEntries.map(([dsId, msg]) => {
            const saved = loadedRef.current?.datasets.find((d) => d.id === dsId);
            return (
              <div key={dsId} className="flex items-center gap-2">
                <span>
                  数据集「{saved?.name ?? dsId}」不可用：{msg}
                </span>
                <button className="underline" onClick={() => void retry(dsId)}>
                  重试
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {!readOnly && (
          <TooltipProvider delayDuration={300}>
            <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-3">
              {NAV_ITEMS.map((item) => {
                const { Icon } = item;
                return (
                  <Tooltip key={item.key}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={item.label}
                        aria-pressed={view === item.key}
                        onClick={() => setView(item.key)}
                        className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                          view === item.key
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <Icon className="h-5 w-5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>
          </TooltipProvider>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {readOnly ? (
            <DashboardView readOnly />
          ) : view === 'dashboard' ? (
            <DashboardView onAddDataset={() => setView('data')} />
          ) : (
            <DataView />
          )}
        </div>
      </div>
      <Toaster position="bottom-left" />
      <UnsavedChangesDialog
        open={pendingPath !== null}
        saving={saving}
        onCancel={() => setPendingPath(null)}
        onDiscard={discardAndLeave}
        onSave={() => void saveAndLeave()}
      />
    </div>
  );
}
