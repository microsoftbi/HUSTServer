/** 展示层格式化工具。 */

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 过长路径中间省略，便于在窄面板中展示。 */
export function shortenPath(path: string, max = 46): string {
  if (path.length <= max) return path;
  const head = path.slice(0, Math.ceil(max / 2) - 1);
  const tail = path.slice(-Math.floor(max / 2));
  return `${head}…${tail}`;
}
