import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { Database, LayoutDashboard } from 'lucide-react';
import { api, ApiClientError } from '../../api.js';
import { useAuth } from '../../auth.js';
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
import type { DashboardPayload, SavedDataset } from './types';

type ViewKey = 'dashboard' | 'data';

const NAV_ITEMS: Array<{ key: ViewKey; label: string; Icon: typeof Database }> = [
  { key: 'dashboard', label: '仪表板', Icon: LayoutDashboard },
  { key: 'data', label: '数据', Icon: Database },
];

export function DashboardEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { hasCap } = useAuth();
  const canEdit = hasCap('dashboard.edit');
  const [rowName, setRowName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('dashboard');
  /** 服务端最近一次已知状态：保存时作为 datasets 合并的底（保留失败/未 hydrate 数据集的定义） */
  const loadedRef = useRef<DashboardPayload | null>(null);

  const errors = useDatasetStore((s) => s.errors);

  const save = useCallback(async () => {
    if (!id) return;
    try {
      setSaving(true);
      const dash = useDashboardStore.getState();
      const data = useDatasetStore.getState();
      const merged = new Map<string, SavedDataset>((loadedRef.current?.datasets ?? []).map((d) => [d.id, d]));
      for (const ds of data.datasets) merged.set(ds.id, { id: ds.id, name: ds.name, def: ds.def });
      const payload: DashboardPayload = {
        version: 2,
        dashboards: dash.dashboards,
        activeId: dash.activeId,
        datasets: [...merged.values()],
      };
      await api.put(`/api/dashboards/${id}`, { body: { payload } });
      loadedRef.current = payload;
      setSavedAt(new Date().toLocaleTimeString());
      toast.success('已保存');
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.message}${err.detail ? `（${err.detail}）` : ''}` : (err as Error).message;
      toast.error(`保存失败：${msg}`);
    } finally {
      setSaving(false);
    }
  }, [id]);

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
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

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
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-50">
        <p className="text-sm text-red-600">加载失败：{loadError}</p>
        <Link className="text-sm text-blue-600 underline" to="/dashboards">
          返回列表
        </Link>
      </div>
    );
  }

  const errorEntries = Object.entries(errors);

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex shrink-0 items-center gap-3 border-b bg-white px-4 py-2">
        <Link className="text-sm text-slate-600 hover:underline" to="/dashboards">
          ← 返回列表
        </Link>
        <span className="font-medium">{rowName || '仪表板'}</span>
        {savedAt && <span className="text-xs text-slate-500">已保存于 {savedAt}</span>}
        {canEdit && (
          <button
            className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={saving || !canEdit}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </header>
      {errorEntries.length > 0 && (
        <div className="shrink-0 space-y-1 bg-red-50 px-4 py-2 text-sm text-red-700">
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
        <div className="min-h-0 flex-1">
          {view === 'dashboard' ? (
            <DashboardView onAddDataset={() => setView('data')} />
          ) : (
            <DataView />
          )}
        </div>
      </div>
      <Toaster position="bottom-left" />
    </div>
  );
}
