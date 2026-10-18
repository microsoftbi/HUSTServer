/** 只读 SQL 校验：数据探索页只允许单条 SELECT / WITH 查询。 */

/**
 * 剥离 SQL 中的注释与字符串/标识符字面量，避免用注释或字面量绕过前缀检查。
 * 字面量整体替换为一个空格，保持词边界。
 */
function stripCommentsAndLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export interface ReadOnlyCheck {
  ok: boolean;
  reason?: string;
}

/** 校验为只读查询：剥离注释/字面量后须以 SELECT 或 WITH 开头，且不含分号分隔的多语句。 */
export function checkReadOnly(sql: string): ReadOnlyCheck {
  if (!sql.trim()) return { ok: false, reason: 'SQL 不能为空' };
  const cleaned = stripCommentsAndLiterals(sql);
  // 允许结尾保留一个分号
  const body = cleaned.replace(/[\s;]+$/, '');
  if (body.includes(';')) {
    return { ok: false, reason: '一次只能执行一条语句' };
  }
  if (!/^\s*(select|with)\b/i.test(body)) {
    return { ok: false, reason: '仅支持只读查询（SELECT / WITH）' };
  }
  return { ok: true };
}
