/** 交叉高亮：不改变聚合结果，仅按选中值调整视觉对象的透明度 */

export interface HighlightSelection {
  /** 参与高亮的维度字段名 */
  field: string;
  /** 选中的维度值（已按标签字符串归一化） */
  values: string[];
  /** 触发高亮的视觉对象 id */
  sourceId: string;
}

/** 未命中项默认变暗透明度 */
export const DIM_OPACITY = 0.25;

/**
 * 计算某个元素的透明度。
 * - 无选中、或该视觉对象未按选中字段分组时保持 1；
 * - 分组字段与选中字段一致时，值命中选中的值返回 1，否则返回变暗透明度。
 */
export function cellOpacity(
  selection: HighlightSelection | null,
  field: string | undefined,
  value: string,
  dimOpacity = DIM_OPACITY,
): number {
  if (!selection || !field || selection.field !== field) return 1;
  return selection.values.includes(value) ? 1 : dimOpacity;
}

/**
 * 点击某个元素后推导新的选中状态。
 * - additive（⌘/Ctrl）且同源同字段：累加或移除，空则清除；
 * - 非累加且同源同字段：点击唯一已选项则清除，否则替换；
 * - 其余情况（换值/换来源/首次）：替换为新选中。
 */
export function toggleSelection(
  prev: HighlightSelection | null,
  field: string,
  value: string,
  sourceId: string,
  additive: boolean,
): HighlightSelection | null {
  const sameTarget =
    prev !== null && prev.field === field && prev.sourceId === sourceId;

  if (additive && sameTarget) {
    const values = prev!.values.includes(value)
      ? prev!.values.filter((v) => v !== value)
      : [...prev!.values, value];
    return values.length > 0 ? { field, values, sourceId } : null;
  }

  if (sameTarget && prev!.values.length === 1 && prev!.values[0] === value) {
    return null;
  }

  return { field, values: [value], sourceId };
}
