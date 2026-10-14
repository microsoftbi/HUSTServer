/**
 * 把 DuckDB / xlsx / mssql 返回的任意 JS 值转换为可安全 JSON 序列化的结构。
 * 统一处理 bigint、Date、Buffer(Uint8Array) 等在 JSON.stringify 下会出问题的类型。
 */

export type JsonSafe =
  | null
  | boolean
  | number
  | string
  | JsonSafe[]
  | { [key: string]: JsonSafe };

const MAX_SAFE = 9007199254740991n;

export function toJsonSafe(value: unknown): JsonSafe {
  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as JsonSafe;
  if (type === 'number') {
    return Number.isFinite(value as number) ? (value as number) : null;
  }
  if (type === 'bigint') {
    const big = value as bigint;
    if (big >= -MAX_SAFE && big <= MAX_SAFE) return Number(big);
    return big.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (type === 'object') {
    const out: Record<string, JsonSafe> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(val);
    }
    return out;
  }
  return String(value);
}

/** 把一行记录转为 JSON 安全的普通对象。 */
export function toJsonSafeRow(row: Record<string, unknown>): Record<string, JsonSafe> {
  const out: Record<string, JsonSafe> = {};
  for (const [key, val] of Object.entries(row)) {
    out[key] = toJsonSafe(val);
  }
  return out;
}
