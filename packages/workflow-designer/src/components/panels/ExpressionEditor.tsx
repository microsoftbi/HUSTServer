import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Sigma } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ColumnMeta } from '@/types';

interface FunctionItem {
  name: string;
  /** `|` 标记插入后光标位置。 */
  snippet: string;
  desc: string;
}

/** 常用函数参考：点击即插入，按 DuckDB（即表达式实际执行方言）编写。 */
const FUNCTION_GROUPS: { label: string; items: FunctionItem[] }[] = [
  {
    label: '字符串',
    items: [
      { name: 'UPPER', snippet: 'UPPER(|)', desc: '转大写' },
      { name: 'LOWER', snippet: 'LOWER(|)', desc: '转小写' },
      { name: 'TRIM', snippet: 'TRIM(|)', desc: '去首尾空格' },
      { name: 'LENGTH', snippet: 'LENGTH(|)', desc: '字符长度' },
      { name: 'SUBSTR', snippet: 'SUBSTR(|, 1, 3)', desc: '截取子串' },
      { name: 'REPLACE', snippet: "REPLACE(|, '旧', '新')", desc: '替换文本' },
      { name: 'CONCAT', snippet: "CONCAT(|, '')", desc: '拼接字符串' },
      { name: 'SPLIT_PART', snippet: "SPLIT_PART(|, ',', 1)", desc: '按分隔符取片段' },
      { name: 'LPAD', snippet: "LPAD(|, 5, '0')", desc: '左补位' },
      { name: 'STARTS_WITH', snippet: "STARTS_WITH(|, '')", desc: '是否以某串开头' },
    ],
  },
  {
    label: '数值',
    items: [
      { name: 'ROUND', snippet: 'ROUND(|, 2)', desc: '四舍五入' },
      { name: 'CEIL', snippet: 'CEIL(|)', desc: '向上取整' },
      { name: 'FLOOR', snippet: 'FLOOR(|)', desc: '向下取整' },
      { name: 'ABS', snippet: 'ABS(|)', desc: '绝对值' },
      { name: 'POWER', snippet: 'POWER(|, 2)', desc: '幂运算' },
      { name: 'MOD', snippet: 'MOD(|, 2)', desc: '取余' },
    ],
  },
  {
    label: '日期',
    items: [
      { name: 'NOW', snippet: 'NOW()', desc: '当前日期时间' },
      { name: 'CURRENT_DATE', snippet: 'CURRENT_DATE', desc: '当前日期' },
      { name: 'DATE_TRUNC', snippet: "DATE_TRUNC('month', |)", desc: '按粒度截断' },
      { name: 'DATE_PART', snippet: "DATE_PART('year', |)", desc: '取日期的某部分' },
      { name: 'DATE_DIFF', snippet: "DATE_DIFF('day', |, CURRENT_DATE)", desc: '两个日期相差' },
      { name: 'STRFTIME', snippet: "STRFTIME(|, '%Y-%m-%d')", desc: '日期格式化为字符串' },
      { name: 'STRPTIME', snippet: "STRPTIME(|, '%Y-%m-%d')", desc: '字符串解析为日期' },
    ],
  },
  {
    label: '正则',
    items: [
      {
        name: 'REGEXP_MATCHES',
        snippet: "REGEXP_MATCHES(|, '^[0-9]+$')",
        desc: '是否匹配正则',
      },
      {
        name: 'REGEXP_REPLACE',
        snippet: "REGEXP_REPLACE(|, '[^0-9]', '', 'g')",
        desc: '正则替换',
      },
      {
        name: 'REGEXP_EXTRACT',
        snippet: "REGEXP_EXTRACT(|, '([0-9]+)', 1)",
        desc: '提取正则捕获组',
      },
    ],
  },
  {
    label: '条件',
    items: [
      {
        name: 'CASE WHEN',
        snippet: 'CASE WHEN | THEN 1 ELSE 0 END',
        desc: '条件分支',
      },
      { name: 'COALESCE', snippet: 'COALESCE(|, 0)', desc: '取第一个非空值' },
      { name: 'NULLIF', snippet: 'NULLIF(|, 0)', desc: '相等时返回 NULL' },
      { name: 'IF', snippet: 'IF(|, 1, 0)', desc: '条件表达式' },
    ],
  },
  {
    label: '类型转换',
    items: [
      { name: 'CAST', snippet: 'CAST(| AS DOUBLE)', desc: '类型转换' },
      { name: 'TRY_CAST', snippet: 'TRY_CAST(| AS DOUBLE)', desc: '失败返回 NULL 的转换' },
    ],
  },
  {
    label: '窗口',
    items: [
      {
        name: 'ROW_NUMBER',
        snippet: 'ROW_NUMBER() OVER (PARTITION BY | ORDER BY 1)',
        desc: '组内行号',
      },
      {
        name: 'RANK',
        snippet: 'RANK() OVER (PARTITION BY | ORDER BY 1)',
        desc: '组内排名',
      },
      {
        name: 'SUM OVER',
        snippet: 'SUM(|) OVER (PARTITION BY )',
        desc: '分组累计',
      },
      { name: 'LAG', snippet: 'LAG(|, 1) OVER (ORDER BY )', desc: '取上一行值' },
      { name: 'LEAD', snippet: 'LEAD(|, 1) OVER (ORDER BY )', desc: '取下一行值' },
    ],
  },
];

/**
 * 表达式静态检查：只做括号/引号配对与明显的残缺判断，不解析 SQL。
 * 返回错误文案，合法时返回 null。
 */
export function validateExpression(expression: string): string | null {
  const text = expression.trim();
  if (!text) return '表达式为空';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'" && !inDouble) {
      if (inSingle && text[i + 1] === "'") {
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      if (inDouble && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return '括号不匹配：多了一个 )';
    }
  }
  if (inSingle) return '字符串引号未闭合';
  if (inDouble) return '字段引号未闭合';
  if (depth > 0) return `括号不匹配：还缺少 ${depth} 个 )`;
  if (/[+\-*/%<>=!&|,]$/.test(text)) return '表达式以运算符结尾，可能不完整';
  if (/\bCASE\b/i.test(text) && !/\bEND\b/i.test(text)) return 'CASE 缺少配对的 END';
  if (/\bOVER\s*\($/i.test(text)) return 'OVER 窗口定义不完整';
  return null;
}

interface ExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  columns: ColumnMeta[];
  placeholder?: string;
  /** 编辑区高度类名，默认公式用的多行高度。 */
  className?: string;
}

/**
 * 表达式编辑器：多行输入 + 函数面板 + 字段插入 + 实时校验。
 * Formula 与 Filter 共用；点击函数/字段会把文本插入到光标处。
 */
export function ExpressionEditor({
  value,
  onChange,
  columns,
  placeholder,
  className,
}: ExpressionEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const error = useMemo(() => validateExpression(value), [value]);

  const insert = (snippet: string) => {
    const element = textareaRef.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    const marker = snippet.indexOf('|');
    const text = marker >= 0 ? snippet.replace('|', '') : snippet;
    onChange(value.slice(0, start) + text + value.slice(end));
    const caret = start + (marker >= 0 ? marker : text.length);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">表达式</span>
        <button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          className={cn(
            'flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            panelOpen && 'bg-accent text-accent-foreground',
          )}
        >
          <Sigma className="size-3" />
          函数
          <ChevronDown className={cn('size-3 transition-transform', panelOpen && 'rotate-180')} />
        </button>
      </div>

      {panelOpen && (
        <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1.5 shadow-md">
          {FUNCTION_GROUPS.map((group) => (
            <div key={group.label} className="mb-1.5 last:mb-0">
              <div className="px-1 pb-0.5 text-[10px] font-medium text-muted-foreground">
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.items.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    title={item.desc}
                    onClick={() => insert(item.snippet)}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(
          'min-h-[80px] font-mono text-xs',
          error && value.trim().length > 0 && 'border-[var(--warning)]',
          className,
        )}
      />

      {value.trim().length > 0 &&
        (error ? (
          <div className="flex items-start gap-1 text-[10px] text-[var(--warning)]">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {error}
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[10px] text-[var(--success)]">
            <CheckCircle2 className="size-3" />
            语法检查通过
          </div>
        ))}

      {columns.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {columns.map((col) => (
            <button
              key={col.name}
              type="button"
              title={`插入字段 ${col.name}（${col.type}）`}
              onClick={() => insert(`"${col.name}"`)}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {col.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
