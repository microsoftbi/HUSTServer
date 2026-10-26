import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../../api.js';
import {
  DEFAULT_CANVAS_THEME,
  canvasTheme,
  isCanvasThemeId,
  type CanvasThemeId,
} from './themes.js';
import { currentUiColorMode } from './uiThemeStore.js';

/** 个人覆盖（localStorage）优先于全局系统设置。 */
const OVERRIDE_KEY = 'hustserver.canvasTheme';

function readOverride(): CanvasThemeId | null {
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return isCanvasThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

interface CanvasThemeState {
  /** 全局系统设置（服务端）；未加载前用默认值。 */
  system: CanvasThemeId;
  /** 个人覆盖；null 表示跟随系统设置。 */
  override: CanvasThemeId | null;
  loaded: boolean;
  /** 拉取全局主题（只拉一次）。 */
  ensureLoaded: () => void;
  /** 设置或清除个人覆盖。 */
  setOverride: (id: CanvasThemeId | null) => void;
  /** 服务端值变更后同步（设置页保存成功时调用）。 */
  setSystem: (id: CanvasThemeId) => void;
}

export const useCanvasThemeStore = create<CanvasThemeState>((set, get) => ({
  system: DEFAULT_CANVAS_THEME,
  override: readOverride(),
  loaded: false,
  ensureLoaded: () => {
    if (get().loaded) return;
    set({ loaded: true });
    void api
      .get<{ canvasTheme: string }>('/api/ui/preferences')
      .then((res) => {
        if (isCanvasThemeId(res.canvasTheme)) set({ system: res.canvasTheme });
      })
      .catch(() => {
        /* 未登录或接口不可用时保持默认主题 */
      });
  },
  setOverride: (id) => {
    try {
      if (id) window.localStorage.setItem(OVERRIDE_KEY, id);
      else window.localStorage.removeItem(OVERRIDE_KEY);
    } catch {
      /* 隐私模式下写入失败不影响本次会话 */
    }
    set({ override: id });
  },
  setSystem: (id) => set({ system: id }),
}));

/** 当前生效的主题 id：个人覆盖 → 全局设置 → 默认。 */
export function useResolvedCanvasTheme(): CanvasThemeId {
  const system = useCanvasThemeStore((s) => s.system);
  const override = useCanvasThemeStore((s) => s.override);
  return override ?? system;
}

/** 当前生效的主题与其明暗模式；顺带触发一次全局设置拉取。 */
export function useCanvasTheme(): { theme: CanvasThemeId; colorMode: 'light' | 'dark' } {
  const theme = useResolvedCanvasTheme();
  const ensureLoaded = useCanvasThemeStore((s) => s.ensureLoaded);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  return { theme, colorMode: canvasTheme(theme).colorMode };
}

/**
 * 编辑页挂载时把主题写到 <html> 上，卸载时移除。
 * 用 <html> 而非编辑器根节点，是为了让弹窗、Toast 等 portal 内容一并换肤；
 * 离开编辑器后属性移除，列表等页面不受影响。
 */
export function useCanvasThemeOnDocument(): CanvasThemeId {
  const { theme, colorMode } = useCanvasTheme();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.canvasTheme = theme;
    root.classList.toggle('dark', colorMode === 'dark');
    return () => {
      delete root.dataset.canvasTheme;
      // 还原界面主题的明暗，避免把全局深色界面一并关掉
      root.classList.toggle('dark', currentUiColorMode() === 'dark');
    };
  }, [theme, colorMode]);

  return theme;
}
