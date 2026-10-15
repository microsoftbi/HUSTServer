import { create } from 'zustand';
import type { Dataset } from '../types';

interface DatasetStoreState {
  datasets: Dataset[];
  /** hydrate 失败的数据集：savedDataset.id → 错误消息（本体不在 datasets 里） */
  errors: Record<string, string>;
  setDatasets: (datasets: Dataset[]) => void;
  addDataset: (dataset: Dataset) => void;
  removeDataset: (id: string) => void;
  setError: (id: string, message: string) => void;
  clearError: (id: string) => void;
  reset: () => void;
}

export const useDatasetStore = create<DatasetStoreState>((set) => ({
  datasets: [],
  errors: {},
  setDatasets: (datasets) => set({ datasets }),
  // 同 id 覆盖：hydrate 重试成功后回填同一份数据集
  addDataset: (dataset) =>
    set((s) => ({ datasets: [...s.datasets.filter((d) => d.id !== dataset.id), dataset] })),
  removeDataset: (id) =>
    set((s) => ({ datasets: s.datasets.filter((d) => d.id !== id) })),
  setError: (id, message) => set((s) => ({ errors: { ...s.errors, [id]: message } })),
  clearError: (id) =>
    set((s) => {
      const errors = { ...s.errors };
      delete errors[id];
      return { errors };
    }),
  reset: () => set({ datasets: [], errors: {} }),
}));
