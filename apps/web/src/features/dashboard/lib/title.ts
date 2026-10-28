// 动态标题 / 文本：在标题或文本框中内嵌度量占位符。
//
// 语法：`本月销售额 {sum(销售额)}`、`客单价 {客单价}`。
// 占位符内容是「度量表达式」——既可以是度量管理里定义的命名度量，
// 也可以直接写 SUM([字段]) / [其它度量] 之类的表达式，与度量管理共用解析器。

import type { CellValue, Dataset, FieldFormat, NamedMeasure } from "@bi/types";
import { formatNumber } from "./format";
import { applyValueFilters, type ValueFilter } from "./highlight";
import {
  baseAggKey,
  collectBaseAggs,
  compileMeasure,
  evaluateMeasure,
  type BaseAgg,
  type CompiledMeasure,
} from "./measure";

const PLACEHOLDER = /\{([^{}]+)\}/g;
const BASE_REF = /^(sum|avg|min|max|count)\((.+)\)$/i;

/** 是否包含占位符（没有占位符时跳过数据计算） */
export function hasPlaceholder(template: string): boolean {
  return /\{[^{}]+\}/.test(template);
}

/** 抽取占位符里的表达式（去重、保持顺序） */
export function placeholderExpressions(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const expr = m[1].trim();
    if (expr && !out.includes(expr)) out.push(expr);
  }
  return out;
}

/**
 * 编译标题占位符表达式。
 * 标题里允许省略字段名的方括号（`sum(金额)`），编译失败时自动补齐再试一次，
 * 与度量管理里要求 `SUM([金额])` 的严格写法并存。
 */
function compileTitleExpr(def: NamedMeasure): CompiledMeasure {
  const cm = compileMeasure(def);
  if (!cm.error) return cm;
  const wrapped = def.expression.replace(
    /\b(sum|avg|min|max|count)\s*\(\s*([^[\]()\s][^[\]()]*?)\s*\)/gi,
    (_m, fn: string, arg: string) => `${fn}([${arg}])`,
  );
  if (wrapped === def.expression) return cm;
  return compileMeasure({ ...def, expression: wrapped });
}

/** 基础聚合在整份数据上的取值（与 aggregate() 的 key 对齐） */
function baseValuesOf(
  rows: CellValue[][],
  bases: BaseAgg[],
  dataset: Dataset,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const base of bases) {
    if (!base.field) {
      out[base.key] = rows.length;
      continue;
    }
    const idx = dataset.columns.findIndex((c) => c.name === base.field);
    if (idx < 0) {
      out[base.key] = null;
      continue;
    }
    let sum = 0;
    let count = 0;
    let numCount = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      const v = row[idx];
      if (v === null || v === undefined || v === "") continue;
      count += 1;
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string" && v.trim() !== ""
            ? Number(v)
            : NaN;
      if (!Number.isFinite(n)) continue;
      sum += n;
      numCount += 1;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (base.agg === "count") out[base.key] = count;
    else if (numCount === 0) out[base.key] = null;
    else if (base.agg === "sum") out[base.key] = sum;
    else if (base.agg === "avg") out[base.key] = sum / numCount;
    else if (base.agg === "min") out[base.key] = min;
    else out[base.key] = max;
  }
  return out;
}

/**
 * 计算占位符取值：表达式 → 数值。
 * 命名度量会展开为依赖的基础聚合；其它度量引用在命名度量表内递归求值。
 */
export function titleValues(
  template: string,
  dataset: Dataset,
  filters?: ValueFilter[] | null,
): Record<string, number | null> {
  const exprs = placeholderExpressions(template);
  const out: Record<string, number | null> = {};
  if (exprs.length === 0) return out;

  const namedByName = new Map<string, NamedMeasure>();
  for (const m of Object.values(dataset.measures ?? {})) namedByName.set(m.name, m);

  const compiled = new Map<string, CompiledMeasure>();
  for (const m of namedByName.values()) compiled.set(m.name, compileMeasure(m));

  // 占位符自身就是一个表达式；命中命名度量时直接复用其定义
  const entries = exprs.map((expr) => {
    const def: NamedMeasure = namedByName.get(expr) ?? {
      id: `__title__${expr}`,
      name: expr,
      expression: expr,
    };
    const cm = compileTitleExpr(def);
    if (!namedByName.has(expr)) compiled.set(def.name, cm);
    return { expr, name: def.name, cm };
  });

  const rows = filters && filters.length > 0
    ? applyValueFilters(dataset, filters).rows
    : dataset.rows;
  const bases = collectBaseAggs(compiled.values());
  const baseValues = baseValuesOf(rows, bases, dataset);

  for (const e of entries) {
    out[e.expr] = e.cm.error ? null : evaluateMeasure(e.name, compiled, baseValues);
  }
  return out;
}

/** 占位符取值对应的数值格式：命名度量优先，其次基础聚合里的字段格式 */
export function titleFormatOf(expr: string, dataset: Dataset): FieldFormat | undefined {
  for (const m of Object.values(dataset.measures ?? {})) {
    if (m.name === expr && m.format) return m.format;
  }
  const m = BASE_REF.exec(expr.trim());
  if (m) {
    const agg = m[1].toLowerCase() as BaseAgg["agg"];
    const field = m[2].trim().replace(/^\[|\]$/g, "");
    const fmt = dataset.formats?.[field];
    if (fmt) return fmt;
    // 兼容不带 [] 的写法
    const alt = dataset.formats?.[baseAggKey(agg, field)];
    if (alt) return alt;
  }
  return undefined;
}

/** 用取值替换模板中的占位符；无法计算时显示 empty */
export function resolveTitleTemplate(
  template: string,
  values: Record<string, number | null>,
  formatOf?: (expr: string) => FieldFormat | undefined,
  empty = "—",
): string {
  return template.replace(PLACEHOLDER, (_match, raw: string) => {
    const expr = raw.trim();
    const v = values[expr];
    if (v === null || v === undefined || !Number.isFinite(v)) return empty;
    return formatNumber(v, formatOf?.(expr));
  });
}
