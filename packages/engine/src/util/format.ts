/** 配置值归一化工具。 */

/** 把界面传入的分隔符描述转换为真实字符。 */
export function normalizeDelimiter(value?: string): string {
  if (!value) return ',';
  if (value === '\\t' || value.toLowerCase() === 'tab') return '\t';
  if (value === '\\n') return '\n';
  if (value === '\\r') return '\r';
  return value;
}

/** 为重复的列名生成唯一名称（追加 _2、_3 …）。 */
export function dedupeNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, index) => {
    let name = raw && raw.length > 0 ? raw : `column_${index + 1}`;
    if (used.has(name)) {
      let candidate = `${name}_2`;
      let i = 2;
      while (used.has(candidate)) {
        i += 1;
        candidate = `${name}_${i}`;
      }
      name = candidate;
    }
    used.add(name);
    return name;
  });
}
