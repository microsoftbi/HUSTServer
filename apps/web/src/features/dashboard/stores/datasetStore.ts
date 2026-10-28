import { create } from 'zustand';
import { hydrateDataset } from '../services/dataSource';
import type { Dataset } from '../types';

interface DatasetStoreState {
  datasets: Dataset[];
  /** hydrate 失败的数据集：savedDataset.id → 错误消息（本体不在 datasets 里） */
  errors: Record<string, string>;
  /** 正在刷新的数据集：savedDataset.id → true */
  refreshing: Record<string, boolean>;
  setDatasets: (datasets: Dataset[]) => void;
  addDataset: (dataset: Dataset) => void;
  /** 局部更新运行时数据集（如字段格式），不影响取数结果 */
  updateDataset: (id: string, patch: Partial<Dataset>) => void;
  removeDataset: (id: string) => void;
  setError: (id: string, message: string) => void;
  clearError: (id: string) => void;
  /** 按落库定义重新取数；成功返回 true，失败保留旧数据并返回 false */
  refreshDataset: (id: string) => Promise<boolean>;
  /** 刷新全部已加载数据集 */
  refreshAll: () => Promise<{ ok: number; failed: number }>;
  reset: () => void;
}

export const useDatasetStore = create<DatasetStoreState>((set, get) => ({
  datasets: [],
  errors: {},
  refreshing: {},
  setDatasets: (datasets) => set({ datasets }),
  // 同 id 覆盖：hydrate 重试成功后回填同一份数据集
  addDataset: (dataset) =>
    set((s) => ({ datasets: [...s.datasets.filter((d) => d.id !== dataset.id), dataset] })),
  updateDataset: (id, patch) =>
    set((s) => ({
      datasets: s.datasets.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),
  removeDataset: (id) =>
    set((s) => ({ datasets: s.datasets.filter((d) => d.id !== id) })),
  setError: (id, message) => set((s) => ({ errors: { ...s.errors, [id]: message } })),
  clearError: (id) =>
    set((s) => {
      const errors = { ...s.errors };
      delete errors[id];
      return { errors };
    }),
  refreshDataset: async (id) => {
    const current = get().datasets.find((d) => d.id === id);
    if (!current) return false;
    set((s) => ({ refreshing: { ...s.refreshing, [id]: true } }));
    try {
      const next = await hydrateDataset({
        id: current.id,
        name: current.name,
        def: current.def,
        formats: current.formats,
        measures: current.measures,
      });
      set((s) => ({ datasets: s.datasets.map((d) => (d.id === id ? next : d)) }));
      get().clearError(id);
      return true;
    } catch {
      // 刷新失败保留上一次的数据，避免仪表板变空
      return false;
    } finally {
      set((s) => {
        const refreshing = { ...s.refreshing };
        delete refreshing[id];
        return { refreshing };
      });
    }
  },
  refreshAll: async () => {
    const ids = get().datasets.map((d) => d.id);
    const results = await Promise.all(ids.map((id) => get().refreshDataset(id)));
    return {
      ok: results.filter(Boolean).length,
      failed: results.filter((v) => !v).length,
    };
  },
  reset: () => set({ datasets: [], errors: {}, refreshing: {} }),
}));
