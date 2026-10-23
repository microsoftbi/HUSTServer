import { create } from "zustand";
import type { ChartWidget, Dashboard } from "@bi/types";
import { uid } from "@bi/lib/utils";

interface DashboardState {
  dashboards: Dashboard[];
  activeId: string;
  setDashboards: (d: Dashboard[]) => void;
  setActive: (id: string) => void;
  addDashboard: (name: string) => void;
  renameDashboard: (id: string, name: string) => void;
  /** 更新仪表板自身的配置（页面尺寸、背景等） */
  updateDashboard: (id: string, patch: Partial<Dashboard>) => void;
  removeDashboard: (id: string) => void;
  addWidget: (widget: ChartWidget) => void;
  updateWidget: (id: string, patch: Partial<ChartWidget>) => void;
  removeWidget: (id: string) => void;
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

  setDashboards: (dashboards) =>
    set({ dashboards, activeId: dashboards[0]?.id ?? "" }),

  setActive: (id) => set({ activeId: id }),

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

  reset: () =>
    set(() => {
      const d = makeDashboard("仪表盘 1");
      return { dashboards: [d], activeId: d.id };
    }),
}));
