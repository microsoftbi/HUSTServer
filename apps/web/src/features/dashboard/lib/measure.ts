// 命名度量：小型表达式层。
// 目标是让「本月销售额 / 上月销售额 - 1」这类口径写一次、到处复用，
// 并且同一份表达式既能前端求值，也能翻译成 SQL 交给数据源执行。
//
// 语法：
//   SUM([字段]) / AVG([字段]) / MIN([字段]) / MAX([字段]) / COUNT([字段])
//   [其它度量名]
//   数字、括号、+ - * /、divide(a, b)
// 字段名与度量名统一用 [] 包裹，避免中文 / 空格字段名带来的歧义。

import type { AggregateFn, CellValue, NamedMeasure, TimeCompareKind } from "@bi/types";

/** 可参与表达式的基础聚合（`none` 无法下推 SQL，也不适用于表达式） */
export type BaseAggFn = Exclude<AggregateFn, "none">;

export interface BaseAgg {
  /** 聚合 key，与 aggregate() / 下推结果的列名一致：`sum(金额)` */
  key: string;
  agg: BaseAggFn;
  field: string;
}

export function baseAggKey(agg: BaseAggFn, field: string): string {
  return `${agg}(${field})`;
}

/* ------------------------------------------------------------ 词法 / 语法 */

type Token =
  | { t: "num"; v: string }
  | { t: "ident"; v: string }
  | { t: "field"; v: string }
  | { t: "op"; v: string };

type Node =
  | { t: "num"; v: number }
  | { t: "base"; agg: BaseAggFn; field: string }
  | { t: "ref"; name: string }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { t: "divide"; a: Node; b: Node };

const AGGS = new Set(["sum", "avg", "min", "max", "count"]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = input.indexOf("]", i + 1);
      if (end < 0) throw new Error("字段名缺少右括号 ]");
      tokens.push({ t: "field", v: input.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j += 1;
      tokens.push({ t: "num", v: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(input[j])) j += 1;
      tokens.push({ t: "ident", v: input.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),".includes(ch)) {
      tokens.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    throw new Error(`无法识别的字符「${ch}」`);
  }
  return tokens;
}

function parseTokens(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v?: string): Token | undefined => {
    const tk = tokens[pos];
    if (!tk) return undefined;
    if (v !== undefined && !(tk.t === "op" && tk.v === v)) return undefined;
    pos += 1;
    return tk;
  };

  function expr(): Node {
    let left = term();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== "op" || (tk.v !== "+" && tk.v !== "-")) break;
      pos += 1;
      const right = term();
      left = { t: "bin", op: tk.v, a: left, b: right };
    }
    return left;
  }

  function term(): Node {
    let left = unary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== "op" || (tk.v !== "*" && tk.v !== "/")) break;
      pos += 1;
      const right = unary();
      left = { t: "bin", op: tk.v, a: left, b: right };
    }
    return left;
  }

  function unary(): Node {
    const tk = peek();
    if (tk && tk.t === "op" && tk.v === "-") {
      pos += 1;
      return { t: "neg", a: unary() };
    }
    if (tk && tk.t === "op" && tk.v === "+") {
      pos += 1;
      return unary();
    }
    return primary();
  }

  function primary(): Node {
    const tk = peek();
    if (!tk) throw new Error("表达式不完整");
    if (tk.t === "num") {
      pos += 1;
      const v = Number(tk.v);
      if (!Number.isFinite(v)) throw new Error(`无效数字「${tk.v}」`);
      return { t: "num", v };
    }
    if (tk.t === "field") {
      pos += 1;
      if (!tk.v) throw new Error("[] 内缺少度量名");
      return { t: "ref", name: tk.v };
    }
    if (tk.t === "ident") {
      pos += 1;
      const fn = tk.v.toLowerCase();
      if (!eat("(")) throw new Error(`「${tk.v}」后缺少左括号 (`);
      if (fn === "divide") {
        const a = expr();
        if (!eat(",")) throw new Error("divide 需要两个参数");
        const b = expr();
        if (!eat(")")) throw new Error("缺少右括号 )");
        return { t: "divide", a, b };
      }
      if (!AGGS.has(fn)) throw new Error(`未知函数「${tk.v}」`);
      const arg = primary();
      if (arg.t !== "ref" && !(arg.t === "num" && fn === "count")) {
        throw new Error(`${fn.toUpperCase()}() 内需要 [字段名]`);
      }
      if (!eat(")")) throw new Error("缺少右括号 )");
      if (arg.t === "ref") {
        return { t: "base", agg: fn as BaseAggFn, field: arg.name };
      }
      // COUNT(1)：按行计数，等价于 COUNT([任意字段])
      return { t: "base", agg: "count" as BaseAggFn, field: "" };
    }
    if (tk.t === "op" && tk.v === "(") {
      pos += 1;
      const inner = expr();
      if (!eat(")")) throw new Error("缺少右括号 )");
      return inner;
    }
    throw new Error(`无法解析「${tk.v}」`);
  }

  const ast = expr();
  if (pos < tokens.length) throw new Error(`多余的内容「${tokens[pos].v}」`);
  return ast;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  if (node.t === "neg") walk(node.a, visit);
  else if (node.t === "bin" || node.t === "divide") {
    walk(node.a, visit);
    walk(node.b, visit);
  }
}

/* ------------------------------------------------------------ 编译 / 求值 */

export interface CompiledMeasure {
  def: NamedMeasure;
  ast: Node | null;
  error?: string;
  /** 表达式依赖的基础聚合（去重） */
  bases: BaseAgg[];
  /** 引用到的其它度量名 */
  refs: string[];
  /** 引用到的全部字段（含 base 聚合中的字段） */
  fields: string[];
}

const compileCache = new Map<string, CompiledMeasure>();

/** 编译度量表达式（按表达式文本缓存，重复渲染不重复解析） */
export function compileMeasure(def: NamedMeasure): CompiledMeasure {
  const cacheKey = def.expression;
  const cached = compileCache.get(cacheKey);
  if (cached) return { ...cached, def };

  const bases: BaseAgg[] = [];
  const refs: string[] = [];
  const fields: string[] = [];
  const seenBase = new Set<string>();

  let ast: Node | null = null;
  let error: string | undefined;
  try {
    ast = parseTokens(tokenize(def.expression ?? ""));
    walk(ast, (n) => {
      if (n.t === "base") {
        if (!n.field) return;
        const key = baseAggKey(n.agg, n.field);
        if (!seenBase.has(key)) {
          seenBase.add(key);
          bases.push({ key, agg: n.agg, field: n.field });
        }
        if (!fields.includes(n.field)) fields.push(n.field);
      } else if (n.t === "ref") {
        if (!refs.includes(n.name)) refs.push(n.name);
      }
    });
    if (ast && ast.t === "num") {
      // 纯数字常量允许保存，但业务上没有意义，给出提示
      error = "表达式只包含常量";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const compiled: CompiledMeasure = { def, ast, error, bases, refs, fields };
  if (compileCache.size > 200) compileCache.clear();
  compileCache.set(cacheKey, { ...compiled, def });
  return compiled;
}

/** 汇总多个度量依赖的基础聚合（去重，保持出现顺序） */
export function collectBaseAggs(compiled: Iterable<CompiledMeasure>): BaseAgg[] {
  const out: BaseAgg[] = [];
  const seen = new Set<string>();
  for (const cm of compiled) {
    for (const b of cm.bases) {
      if (seen.has(b.key)) continue;
      seen.add(b.key);
      out.push(b);
    }
  }
  return out;
}

/**
 * 求值：`baseValues` 的 key 为 `sum(金额)`，`[其它度量]` 递归求值。
 * 任一分量为空 / 除零时返回 null，图表按空值处理（不显示 0 造成误读）。
 */
export function evaluateMeasure(
  name: string,
  compiled: Map<string, CompiledMeasure>,
  baseValues: Record<string, number | null>,
  stack: Set<string> = new Set(),
): number | null {
  if (stack.has(name)) return null;
  const cm = compiled.get(name);
  if (!cm || !cm.ast || cm.error) return null;
  const next = new Set(stack);
  next.add(name);
  const value = evalNode(cm.ast, baseValues, compiled, next);
  return value === null || Number.isFinite(value) ? value : null;
}

function evalNode(
  node: Node,
  baseValues: Record<string, number | null>,
  compiled: Map<string, CompiledMeasure>,
  stack: Set<string>,
): number | null {
  switch (node.t) {
    case "num":
      return node.v;
    case "base": {
      if (!node.field) return null;
      const v = baseValues[baseAggKey(node.agg, node.field)];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    case "ref":
      return evaluateMeasure(node.name, compiled, baseValues, stack);
    case "neg": {
      const v = evalNode(node.a, baseValues, compiled, stack);
      return v === null ? null : -v;
    }
    case "divide": {
      const a = evalNode(node.a, baseValues, compiled, stack);
      const b = evalNode(node.b, baseValues, compiled, stack);
      if (a === null || b === null || b === 0) return null;
      return a / b;
    }
    case "bin": {
      const a = evalNode(node.a, baseValues, compiled, stack);
      const b = evalNode(node.b, baseValues, compiled, stack);
      if (a === null || b === null) return null;
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      return b === 0 ? null : a / b;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------ SQL 翻译 */

export interface SqlOptions {
  /** 标识符引用方式，默认用双引号 */
  quote?: (id: string) => string;
  /** 命名度量 → SQL（递归展开其它度量）；缺省时遇到度量引用返回 null */
  resolve?: (name: string) => string | null;
}

/**
 * 把表达式翻译成 SQL 聚合表达式。
 * 结果可直接放进 SELECT / GROUP BY 查询，例如：
 *   SUM("金额") / NULLIF(SUM("数量"), 0)
 */
export function measureToSql(
  expression: string,
  options: SqlOptions = {},
): { sql: string | null; error?: string } {
  const quote = options.quote ?? ((id: string) => `"${id.replace(/"/g, '""')}"`);
  let ast: Node;
  try {
    ast = parseTokens(tokenize(expression ?? ""));
  } catch (e) {
    return { sql: null, error: e instanceof Error ? e.message : String(e) };
  }

  const errors: string[] = [];
  const toSql = (node: Node): string | null => {
    switch (node.t) {
      case "num":
        return String(node.v);
      case "base":
        if (!node.field) return "COUNT(*)";
        return `${node.agg.toUpperCase()}(${quote(node.field)})`;
      case "ref": {
        const resolved = options.resolve?.(node.name);
        if (!resolved) {
          errors.push(`无法解析度量「${node.name}」`);
          return null;
        }
        return `(${resolved})`;
      }
      case "neg": {
        const a = toSql(node.a);
        return a === null ? null : `-(${a})`;
      }
      case "divide": {
        const a = toSql(node.a);
        const b = toSql(node.b);
        return a === null || b === null ? null : `(${a} / NULLIF(${b}, 0))`;
      }
      case "bin": {
        const a = toSql(node.a);
        const b = toSql(node.b);
        if (a === null || b === null) return null;
        if (node.op === "/") return `(${a} / NULLIF(${b}, 0))`;
        return `(${a} ${node.op} ${b})`;
      }
      default:
        return null;
    }
  };

  const sql = toSql(ast);
  if (sql === null) {
    return { sql: null, error: errors[0] ?? "无法翻译为 SQL" };
  }
  return { sql };
}

/** 度量及其依赖度量的 SQL（用于「SQL 预览」；循环引用返回 null） */
export function measureSqlOf(
  def: NamedMeasure,
  all: Record<string, NamedMeasure>,
): { sql: string | null; error?: string } {
  const resolving = new Set<string>();
  const resolve = (name: string): string | null => {
    const target =
      Object.values(all).find((m) => m.name === name) ?? all[name];
    if (!target) return null;
    if (resolving.has(target.name)) return null;
    resolving.add(target.name);
    const out = measureToSql(target.expression, { resolve });
    resolving.delete(target.name);
    return out.sql;
  };
  return measureToSql(def.expression, { resolve });
}

/* ------------------------------------------------------------ 时间对比 */

export const TIME_COMPARE_LABELS: Record<TimeCompareKind, string> = {
  yoy: "同比",
  mom: "环比",
  qoq: "季环比",
  wow: "周环比",
  dod: "日环比",
};

export function timeCompareLabel(kind: TimeCompareKind): string {
  return TIME_COMPARE_LABELS[kind] ?? "对比";
}

type PeriodUnit = "day" | "week" | "month" | "quarter";

const PERIOD_UNIT: Record<TimeCompareKind, PeriodUnit> = {
  yoy: "month",
  mom: "month",
  qoq: "quarter",
  wow: "week",
  dod: "day",
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function periodKeyFromDate(d: Date, unit: PeriodUnit): string {
  const y = d.getFullYear();
  if (unit === "month") return `${y}-${pad(d.getMonth() + 1)}`;
  if (unit === "quarter") return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  if (unit === "week") {
    // 以周一作为一周的锚点，便于直接按 7 天回退
    const monday = new Date(d);
    const day = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - day);
    return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
  }
  return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function epochOf(value: CellValue | string | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

/** 单元格值 → 所属周期 key（无法解析返回 null） */
export function periodKeyOf(value: CellValue | string, kind: TimeCompareKind): string | null {
  const t = epochOf(value);
  if (t === null) return null;
  return periodKeyFromDate(new Date(t), PERIOD_UNIT[kind]);
}

function parsePeriodKey(key: string, unit: PeriodUnit): Date | null {
  if (unit === "month") {
    const m = /^(\d{4})-(\d{1,2})$/.exec(key);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, 1);
  }
  if (unit === "quarter") {
    const m = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!m) return null;
    return new Date(Number(m[1]), (Number(m[2]) - 1) * 3, 1);
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(key);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 上一周期的 key：同比回退 1 年、环比回退 1 个月、季环比 1 季度、周环比 7 天、日环比 1 天 */
export function previousPeriodKey(key: string, kind: TimeCompareKind): string | null {
  const unit = PERIOD_UNIT[kind];
  const d = parsePeriodKey(key, unit);
  if (!d) return null;
  if (kind === "yoy") d.setFullYear(d.getFullYear() - 1);
  else if (kind === "mom") d.setMonth(d.getMonth() - 1);
  else if (kind === "qoq") d.setMonth(d.getMonth() - 3);
  else if (kind === "wow") d.setDate(d.getDate() - 7);
  else d.setDate(d.getDate() - 1);
  return periodKeyFromDate(d, unit);
}

export interface PeriodRow {
  /** 维度标签（用于按周期查找同组数据） */
  label: string;
  /** 该行所属周期 key */
  period: string | null;
  value: number | null;
}

/**
 * 按周期对齐「上一周期」的值：当前行周期回退一格后，
 * 用同一批聚合行里该周期的值作为对比值。缺失周期返回 null。
 */
export function alignPreviousPeriod(
  rows: PeriodRow[],
  kind: TimeCompareKind,
): Array<number | null> {
  const byPeriod = new Map<string, number | null>();
  for (const row of rows) {
    if (row.period === null) continue;
    if (typeof row.value === "number") byPeriod.set(row.period, row.value);
  }
  return rows.map((row) => {
    if (row.period === null) return null;
    const prev = previousPeriodKey(row.period, kind);
    if (!prev) return null;
    const v = byPeriod.get(prev);
    return typeof v === "number" ? v : null;
  });
}
