/** 画布配色主题：工作流设计器与 Job 编排共用一套。变量定义见 index.css 的 .canvas-theme 块。 */
export type CanvasThemeId = 'midnight' | 'graphite' | 'daylight' | 'ocean';

export interface CanvasThemeDefinition {
  id: CanvasThemeId;
  label: string;
  description: string;
  /** React Flow 的 colorMode，决定画布默认的连线/控件底色。 */
  colorMode: 'light' | 'dark';
  /** 设置页缩略图用的近似色（与 index.css 中的主题变量保持一致）。 */
  preview: { background: string; card: string; border: string };
}

export const CANVAS_THEMES: CanvasThemeDefinition[] = [
  {
    id: 'midnight',
    label: '深空',
    description: '默认深灰蓝，长时间编辑不刺眼。',
    colorMode: 'dark',
    preview: {
      background: 'oklch(0.16 0.005 260)',
      card: 'oklch(0.21 0.006 260)',
      border: 'oklch(0.3 0.008 260)',
    },
  },
  {
    id: 'graphite',
    label: '纯黑',
    description: 'OLED 纯黑底，对比度最高。',
    colorMode: 'dark',
    preview: { background: '#000000', card: 'oklch(0.12 0 0)', border: 'oklch(0.24 0 0)' },
  },
  {
    id: 'daylight',
    label: '浅色',
    description: '白底浅灰，适合投影与截图。',
    colorMode: 'light',
    preview: {
      background: 'oklch(0.97 0 0)',
      card: 'oklch(1 0 0)',
      border: 'oklch(0.9 0 0)',
    },
  },
  {
    id: 'ocean',
    label: '午夜蓝',
    description: '冷调蓝黑，更有品牌感。',
    colorMode: 'dark',
    preview: {
      background: 'oklch(0.19 0.03 250)',
      card: 'oklch(0.24 0.035 250)',
      border: 'oklch(0.33 0.04 250)',
    },
  },
];

export const DEFAULT_CANVAS_THEME: CanvasThemeId = 'midnight';

export const CANVAS_THEME_IDS: readonly CanvasThemeId[] = CANVAS_THEMES.map((theme) => theme.id);

export function isCanvasThemeId(value: unknown): value is CanvasThemeId {
  return typeof value === 'string' && (CANVAS_THEME_IDS as readonly string[]).includes(value);
}

/** 取主题定义；未知 id 回退到默认主题。 */
export function canvasTheme(id: CanvasThemeId): CanvasThemeDefinition {
  return CANVAS_THEMES.find((theme) => theme.id === id) ?? CANVAS_THEMES[0];
}
