import { CANVAS_THEMES, type CanvasThemeId } from './themes.js';

/** 界面配色主题：导航、列表、表单等整个界面共用；与画布主题分开配置。 */
export type UiThemeId = 'classic' | CanvasThemeId;

export interface UiThemeDefinition {
  id: UiThemeId;
  label: string;
  description: string;
  /** 深色主题会给 <html> 挂 dark 类，供组件的 dark: 变体使用。 */
  colorMode: 'light' | 'dark';
  /** 设置页缩略图用的近似色（与 index.css 中的界面主题变量保持一致）。 */
  preview: { background: string; card: string; border: string };
}

export const UI_THEMES: UiThemeDefinition[] = [
  {
    id: 'classic',
    label: '默认浅色',
    description: '与原有界面一致的纯白底色。',
    colorMode: 'light',
    preview: {
      background: 'oklch(1 0 0)',
      card: 'oklch(1 0 0)',
      border: 'oklch(0.922 0 0)',
    },
  },
  ...CANVAS_THEMES.map(
    (theme): UiThemeDefinition => ({
      id: theme.id,
      label: theme.label,
      description: theme.description,
      colorMode: theme.colorMode,
      preview: theme.preview,
    }),
  ),
];

export const DEFAULT_UI_THEME: UiThemeId = 'classic';

export const UI_THEME_IDS: readonly UiThemeId[] = UI_THEMES.map((theme) => theme.id);

export function isUiThemeId(value: unknown): value is UiThemeId {
  return typeof value === 'string' && (UI_THEME_IDS as readonly string[]).includes(value);
}

/** 取界面主题定义；未知 id 回退到默认主题。 */
export function uiTheme(id: UiThemeId): UiThemeDefinition {
  return UI_THEMES.find((theme) => theme.id === id) ?? UI_THEMES[0];
}
