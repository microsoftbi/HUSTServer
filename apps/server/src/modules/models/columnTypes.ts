import type { ColumnInfo } from '@hustserver/engine';
import type { QueryCell, QueryColumn } from '../data/query.js';

/** 用户在「配置」中可指定的逻辑列类型 */
export type LogicalColumnType = 'string' | 'number' | 'date' | 'boolean';

export const LOGICAL_COLUMN_TYPES: readonly LogicalColumnType[] = ['string', 'number', 'date', 'boolean'];

/** 类型配置的存储结构（与 model_column_configs.columns 的 JSON 一致） */
export interface StoredColumnType {
  name: string;
  type: LogicalColumnType;
}

/** DuckDB 原生类型 → 逻辑类型（用于配置弹窗展示） */
export function toLogicalType(duckType: string): LogicalColumnType {
  const t = duckType.toUpperCase();
  if (/^(BOOLEAN|BOOL)$/.test(t)) return 'boolean';
  if (/^(DATE|TIMESTAMP|TIME)/.test(t)) return 'date';
  if (/INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL/.test(t)) return 'number';
  return 'string';
}

/** 逻辑类型 → DuckDB 类型名（写回列元数据，供前端判定数值列等） */
export function toDuckType(type: LogicalColumnType): string {
  switch (type) {
    case 'number':
      return 'DOUBLE';
    case 'date':
      return 'TIMESTAMP';
    case 'boolean':
      return 'BOOLEAN';
    default:
      return 'VARCHAR';
  }
}

/** 合并原始列与用户配置：配置优先，未配置的列保持原类型 */
export function mergeColumnTypes(
  columns: ColumnInfo[],
  overrides: Record<string, LogicalColumnType>,
): ColumnInfo[] {
  return columns.map((c) => {
    const override = overrides[c.name];
    return override ? { name: c.name, type: toDuckType(override) } : c;
  });
}

/** 解析存储的 JSON；非法项直接忽略（防手改库或历史脏数据） */
export function parseColumnTypeConfig(json: string | null): Record<string, LogicalColumnType> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!Array.isArray(raw)) return {};
  const out: Record<string, LogicalColumnType> = {};
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, type } = item as { name?: unknown; type?: unknown };
    if (typeof name !== 'string' || !name) continue;
    if (typeof type !== 'string' || !LOGICAL_COLUMN_TYPES.includes(type as LogicalColumnType)) continue;
    out[name] = type as LogicalColumnType;
  }
  return out;
}

/** 按目标逻辑类型转换单元格值（语义与前端 coerceCell 一致） */
export function coerceCell(value: QueryCell, type: LogicalColumnType): QueryCell {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? null : n;
    }
    case 'boolean':
      return String(value).trim().toLowerCase() === 'true';
    case 'date': {
      const t = Date.parse(String(value));
      return Number.isNaN(t) ? String(value) : new Date(t).toISOString();
    }
    default:
      return String(value);
  }
}

/** 逻辑类型 → 查询结果列类型（QueryColumn 的类型名与逻辑类型同名） */
export function toQueryColumnType(type: LogicalColumnType): QueryColumn['type'] {
  return type;
}
