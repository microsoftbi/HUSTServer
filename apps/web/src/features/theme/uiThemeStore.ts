import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../../api.js';
import { DEFAULT_UI_THEME, isUiThemeId, uiTheme, type UiThemeId } from './uiThemes.js';

/** 界面主题的个人覆盖（localStorage）优先于全局系统设置；与画布主题分开存储。 */
const OVERRIDE_KEY = 'hustserver.uiTheme';

function readOverride(): UiThemeId | null {
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return isUiThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

interface UiThemeState {
  /** 全局系统设置（服务端）；未加载前用默认值。 */
  system: UiThemeId;
  /** 个人覆盖；null 表示跟随系统设置。 */
  override: UiThemeId | null;
  loaded: boolean;
  /** 拉取全局主题（登录成功后调用；失败时不置 loaded，便于下次重试）。 */
  ensureLoaded: () => void;
  /** 设置或清除个人覆盖。 */
  setOverride: (id: UiThemeId | null) => void;
  /** 服务端值变更后同步（设置页保存成功时调用）。 */
  setSystem: (id: UiThemeId) => void;
}

export const useUiThemeStore = create<UiThemeState>((set, get) => ({
  system: DEFAULT_UI_THEME,
  override: readOverride(),
  loaded: false,
  ensureLoaded: () => {
    if (get().loaded) return;
    void api
      .get<{ uiTheme: string }>('/api/ui/preferences')
      .then((res) => {
        if (isUiThemeId(res.uiTheme)) set({ system: res.uiTheme, loaded: true });
      })
      .catch(() => {
        /* 未登录或接口不可用时保持默认主题，下次挂载再试 */
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

/** 当前生效的界面主题 id：个人覆盖 → 全局设置 → 默认。 */
export function useResolvedUiTheme(): UiThemeId {
  const system = useUiThemeStore((s) => s.system);
  const override = useUiThemeStore((s) => s.override);
  return override ?? system;
}

/** 当前生效的界面主题与其明暗模式；顺带触发一次全局设置拉取。 */
export function useUiTheme(): { theme: UiThemeId; colorMode: 'light' | 'dark' } {
  const theme = useResolvedUiTheme();
  const ensureLoaded = useUiThemeStore((s) => s.ensureLoaded);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  return { theme, colorMode: uiTheme(theme).colorMode };
}

/** 供画布主题卸载时还原 <html> 明暗用：直接读取当前界面主题。 */
export function currentUiColorMode(): 'light' | 'dark' {
  const { system, override } = useUiThemeStore.getState();
  return uiTheme(override ?? system).colorMode;
}

/**
 * 应用根节点挂载：把界面主题写到 <html> 上，全站生效。
 * 编辑器内由画布主题接管 data-canvas-theme 与 dark 类，这里不覆盖。
 */
export function useUiThemeOnDocument(): UiThemeId {
  const { theme, colorMode } = useUiTheme();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.uiTheme = theme;
    if (!root.dataset.canvasTheme) root.classList.toggle('dark', colorMode === 'dark');
  }, [theme, colorMode]);

  return theme;
}
