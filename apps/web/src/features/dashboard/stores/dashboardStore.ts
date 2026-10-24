import { create } from "zustand";
import type { ChartWidget, Dashboard, FilterCondition, SlicerConfig } from "@bi/types";
import { slicerOf } from "@bi/lib/slicer";
import { uid } from "@bi/lib/utils";

interface DashboardState {
  dashboards: Dashboard[];
  activeId: string;
  /** 报表级筛选器（所有页面上的筛选器） */
  reportFilters: FilterCondition[];
  /** 视图 → 同步切片器：相同字段的切片器跨页联动 */
  syncSlicers: boolean;
  setDashboards: (d: Dashboard[]) => void;
  setActive: (id: string) => void;
  setReportFilters: (filters: FilterCondition[]) => void;
  setSyncSlicers: (on: boolean) => void;
  /** 把一个切片器的选择状态同步到其它页同数据集、同字段的切片器 */
  syncSlicerState: (sourceId: string, slicer: SlicerConfig) => void;
  addDashboard: (name: string) => void;
  renameDashboard: (id: string, name: string) => void;
  /** 更新仪表板自身的配置（页面尺寸、背景等） */
  updateDashboard: (id: string, patch: Partial<Dashboard>) => void;
  removeDashboard: (id: string) => void;
  addWidget: (widget: ChartWidget) => void;
  updateWidget: (id: string, patch: Partial<ChartWidget>) => void;
  removeWidget: (id: string) => void;
  /** 调整图层顺序：数组越靠后越靠前（对齐 Power BI 选择窗格） */
  reorderWidgets: (ids: string[]) => void;
  /** 清空所有仪表盘状态（加载项目前调用） */
  reset: () => void;
}

function makeDashboard(name: string): Dashboard {
  return { id: uid("dash"), name, widgets: [] };
}

const initialDashboard = makeDashboard("仪表盘 1");

export const useDashboardStore = create<DashboardState>((set) => ({
  dashboards: [initialDashboard],
  activeId: initialDashboard.id,
  reportFilters: [],
  syncSlicers: false,

  setDashboards: (dashboards) =>
    set({ dashboards, activeId: dashboards[0]?.id ?? "" }),

  setActive: (id) => set({ activeId: id }),

  setReportFilters: (filters) => set({ reportFilters: filters }),

  setSyncSlicers: (on) => set({ syncSlicers: on }),

  syncSlicerState: (sourceId, slicer) =>
    set((s) => {
      const source = s.dashboards.flatMap((d) => d.widgets).find((w) => w.id === sourceId);
      const fields = [...(source?.filterFields ?? [])].sort().join("|");
      if (!source || !fields) return {};
      return {
        dashboards: s.dashboards.map((d) => ({
          ...d,
          widgets: d.widgets.map((w) => {
            if (w.id === sourceId) return { ...w, slicer };
            if (w.type !== "filter" || w.datasetId !== source.datasetId) return w;
            const own = [...(w.filterFields ?? [])].sort().join("|");
            if (own !== fields) return w;
            return { ...w, slicer: { ...slicerOf(w), state: slicer.state } };
          }),
        })),
      };
    }),

  addDashboard: (name) =>
    set((s) => {
      const d = makeDashboard(name);
      return { dashboards: [...s.dashboards, d], activeId: d.id };
    }),

  renameDashboard: (id, name) =>
    set((s) => ({
      dashboards: s.dashboards.map((d) => (d.id === id ? { ...d, name } : d)),
    })),

  updateDashboard: (id, patch) =>
    set((s) => ({
      dashboards: s.dashboards.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),

  removeDashboard: (id) =>
    set((s) => {
      const dashboards = s.dashboards.filter((d) => d.id !== id);
      const next = dashboards.length ? dashboards : [makeDashboard("仪表盘 1")];
      return {
        dashboards: next,
        activeId: s.activeId === id ? next[0].id : s.activeId,
      };
    }),

  addWidget: (widget) =>
    set((s) => ({
      dashboards: s.dashboards.map((d) =>
        d.id === s.activeId ? { ...d, widgets: [...d.widgets, widget] } : d,
      ),
    })),

  updateWidget: (id, patch) =>
    set((s) => ({
      dashboards: s.dashboards.map((d) =>
        d.id === s.activeId
          ? {
              ...d,
              widgets: d.widgets.map((w) =>
                w.id === id ? { ...w, ...patch } : w,
              ),
            }
          : d,
      ),
    })),

  removeWidget: (id) =>
    set((s) => ({
      dashboards: s.dashboards.map((d) =>
        d.id === s.activeId
          ? { ...d, widgets: d.widgets.filter((w) => w.id !== id) }
          : d,
      ),
    })),

  reorderWidgets: (ids) =>
    set((s) => ({
      dashboards: s.dashboards.map((d) => {
        if (d.id !== s.activeId) return d;
        const byId = new Map(d.widgets.map((w) => [w.id, w]));
        const next: ChartWidget[] = [];
        for (const id of ids) {
          const w = byId.get(id);
          if (w) {
            next.push(w);
            byId.delete(id);
          }
        }
        // 兜底：未出现在列表中的视觉对象保持原有相对顺序，追加到最前
        return { ...d, widgets: [...next, ...byId.values()] };
      }),
    })),

  reset: () =>
    set(() => {
      const d = makeDashboard("仪表盘 1");
      return {
        dashboards: [d],
        activeId: d.id,
        reportFilters: [],
        syncSlicers: false,
      };
    }),
}));
