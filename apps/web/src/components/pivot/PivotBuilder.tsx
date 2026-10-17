import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, GripVertical, Loader2, RefreshCw, X } from 'lucide-react';
import { api, ApiClientError } from '../../api.js';
import { Button } from '../ui/button.js';
import { ErrorNote } from '../ui/error-note.js';
import { Modal } from '../ui/modal.js';
import {
  buildPivotMatrix,
  mergeLabels,
  PIVOT_MAX_COLS,
  PIVOT_MAX_ROWS,
  type MergedLabel,
  type PivotCell,
  type PivotMatrix,
  type PivotRawResult,
} from './matrix.js';

/** 字段列表项（来自数据模型页的列定义） */
export interface PivotModelColumn {
  name: string;
  type: string;
}

interface PivotBuilderProps {
  open: boolean;
  modelName: string;
  columns: PivotModelColumn[];
  onClose: () => void;
}

type PivotAgg = 'sum' | 'count' | 'avg' | 'min' | 'max';
type ZoneKey = 'rows' | 'columns' | 'values' | 'filters';

const AGG_OPTIONS: Array<{ value: PivotAgg; label: string }> = [
  { value: 'sum', label: '求和' },
  { value: 'count', label: '计数' },
  { value: 'avg', label: '平均' },
  { value: 'min', label: '最小' },
  { value: 'max', label: '最大' },
];

/** 与后端一致的上限：行/列各 3 个字段、4 个数值、3 个筛选 */
const MAX_AXIS_FIELDS = 3;
const MAX_VALUES = 4;
const MAX_FILTERS = 3;

/** 拖拽载荷 MIME（与工作流设计器的字段拖拽保持一致） */
const FIELD_MIME = 'application/x-bi-field';

/** DuckDB 数值类型判定：决定默认聚合与是否可直接求和 */
function isNumericType(type: string): boolean {
  return /INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL/i.test(type);
}

function fmt(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** 筛选值在 UI 上一律按字符串处理（提交时也发字符串） */
function optionKey(value: PivotCell): string {
  return value === null || value === undefined ? '' : String(value);
}

interface FilterOptionState {
  loading: boolean;
  values: string[];
  truncated: boolean;
  error?: string;
}

export function PivotBuilder({ open, modelName, columns, onClose }: PivotBuilderProps) {
  const [rowFields, setRowFields] = useState<string[]>([]);
  const [columnFields, setColumnFields] = useState<string[]>([]);
  const [valueFields, setValueFields] = useState<Array<{ field: string; agg: PivotAgg }>>([]);
  const [filters, setFilters] = useState<Array<{ field: string; values: string[] }>>([]);
  const [options, setOptions] = useState<Record<string, FilterOptionState>>({});
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [result, setResult] = useState<PivotRawResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState<ZoneKey | null>(null);

  // 打开弹窗（或切换模型）时重置配置
  useEffect(() => {
    if (!open) return;
    setRowFields([]);
    setColumnFields([]);
    setValueFields([]);
    setFilters([]);
    setOptions({});
    setOpenFilter(null);
    setResult(null);
    setError(null);
    setNotice(null);
  }, [open, modelName]);

  function defaultAgg(field: string): PivotAgg {
    const col = columns.find((c) => c.name === field);
    return col && isNumericType(col.type) ? 'sum' : 'count';
  }

  function addField(field: string, zone: ZoneKey): void {
    setNotice(null);
    if (zone === 'rows' || zone === 'columns') {
      const [self, setSelf, other, setOther] =
        zone === 'rows'
          ? ([rowFields, setRowFields, columnFields, setColumnFields] as const)
          : ([columnFields, setColumnFields, rowFields, setRowFields] as const);
      if (self.includes(field)) return;
      if (self.length >= MAX_AXIS_FIELDS) {
        setNotice(`${zone === 'rows' ? 'Y 轴（行）' : 'X 轴（列）'}最多 ${MAX_AXIS_FIELDS} 个字段`);
        return;
      }
      // 同一字段不同时出现在两个轴上：拖到另一轴时移动过去
      if (other.includes(field)) setOther(other.filter((f) => f !== field));
      setSelf([...self, field]);
      return;
    }
    if (zone === 'values') {
      if (valueFields.some((v) => v.field === field)) return;
      if (valueFields.length >= MAX_VALUES) {
        setNotice(`数值最多 ${MAX_VALUES} 个字段`);
        return;
      }
      setValueFields([...valueFields, { field, agg: defaultAgg(field) }]);
      return;
    }
    if (filters.some((f) => f.field === field)) return;
    if (filters.length >= MAX_FILTERS) {
      setNotice(`筛选列最多 ${MAX_FILTERS} 个字段`);
      return;
    }
    setFilters([...filters, { field, values: [] }]);
    void loadOptions(field);
  }

  function removeField(field: string, zone: ZoneKey): void {
    if (zone === 'rows') setRowFields(rowFields.filter((f) => f !== field));
    else if (zone === 'columns') setColumnFields(columnFields.filter((f) => f !== field));
    else if (zone === 'values') setValueFields(valueFields.filter((v) => v.field !== field));
    else {
      setFilters(filters.filter((f) => f.field !== field));
      if (openFilter === field) setOpenFilter(null);
    }
  }

  async function loadOptions(field: string): Promise<void> {
    setOptions((prev) => ({ ...prev, [field]: { loading: true, values: [], truncated: false } }));
    try {
      const res = await api.post<{ values: PivotCell[]; truncated: boolean }>('/api/models/distinct', {
        body: { name: modelName, field },
      });
      // 空值无法用等值筛选表达，过滤掉后另行提示
      const values = res.values.map(optionKey).filter((v) => v !== '');
      setOptions((prev) => ({ ...prev, [field]: { loading: false, values, truncated: res.truncated } }));
    } catch (err) {
      setOptions((prev) => ({
        ...prev,
        [field]: { loading: false, values: [], truncated: false, error: errText(err) },
      }));
    }
  }

  const runPivot = useCallback(async (): Promise<void> => {
    if (valueFields.length === 0) {
      setResult(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<PivotRawResult>('/api/models/pivot', {
        body: {
          name: modelName,
          rows: rowFields,
          columns: columnFields,
          values: valueFields,
          filters: filters.map((f) => ({ field: f.field, values: f.values })),
        },
      });
      setResult(res);
      setError(null);
    } catch (err) {
      setError(errText(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [modelName, rowFields, columnFields, valueFields, filters]);

  // 配置变化后防抖自动执行（聚合在后端下推，无需手动点执行）
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void runPivot(), 300);
    return () => clearTimeout(timer);
  }, [open, runPivot]);

  const matrix = useMemo(() => (result ? buildPivotMatrix(result) : null), [result]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`透视 · ${modelName}`}
      className="max-w-[92vw]"
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex h-[74vh] min-h-0 gap-3">
        {/* 左：结果区 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {loading && (
              <span className="flex items-center gap-1 text-primary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                聚合中…
              </span>
            )}
            {result && (
              <>
                <span>已聚合全量 {result.totalRows.toLocaleString()} 行</span>
                {matrix && <span>· {matrix.rowLabels.length} 行 × {matrix.columnHeaders.length} 列</span>}
              </>
            )}
            {(result?.truncated || matrix?.rowsTruncated || matrix?.colsTruncated) && (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                结果已截断
                {matrix?.rowsTruncated ? `（仅显示前 ${PIVOT_MAX_ROWS} 行）` : ''}
                {matrix?.colsTruncated ? `（仅显示前 ${PIVOT_MAX_COLS} 列）` : ''}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={loading || valueFields.length === 0}
              onClick={() => void runPivot()}
            >
              <RefreshCw />
              重新加载
            </Button>
          </div>

          {notice && <p className="text-xs text-warning">{notice}</p>}
          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
            {matrix ? (
              <PivotMatrixTable matrix={matrix} rowFieldNames={result?.rowFields ?? []} />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                把右侧的字段拖到 <b className="mx-1">X 轴 / Y 轴</b> 上，并至少放一个字段到
                <b className="mx-1">数值</b>，即可生成透视表。
              </div>
            )}
          </div>
        </div>

        {/* 右：字段列表 + 功能区 */}
        <div className="flex w-[440px] shrink-0 gap-2">
          <section className="flex w-[168px] shrink-0 flex-col rounded-md border border-border">
            <h3 className="border-b border-border/70 px-2.5 py-2 text-xs font-semibold">字段</h3>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {columns.map((col) => (
                <div
                  key={col.name}
                  role="button"
                  tabIndex={0}
                  draggable
                  title="拖到右侧区域，或点击加入数值"
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FIELD_MIME, col.name);
                    e.dataTransfer.setData('text/plain', col.name);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => addField(col.name, 'values')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      addField(col.name, 'values');
                    }
                  }}
                  className="flex cursor-grab items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-accent active:cursor-grabbing"
                >
                  <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{col.name}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="flex min-w-0 flex-1 flex-col gap-2 overflow-auto">
            <Well
              zone="columns"
              title="X 轴（列）"
              hint="横向展开的维度"
              over={over === 'columns'}
              onOver={setOver}
              onDropField={(f) => addField(f, 'columns')}
            >
              {columnFields.map((f) => (
                <FieldChip key={f} label={f} onRemove={() => removeField(f, 'columns')} />
              ))}
            </Well>

            <Well
              zone="rows"
              title="Y 轴（行）"
              hint="纵向堆叠的维度"
              over={over === 'rows'}
              onOver={setOver}
              onDropField={(f) => addField(f, 'rows')}
            >
              {rowFields.map((f) => (
                <FieldChip key={f} label={f} onRemove={() => removeField(f, 'rows')} />
              ))}
            </Well>

            <Well
              zone="values"
              title="数值"
              hint="聚合方式可切换"
              over={over === 'values'}
              onOver={setOver}
              onDropField={(f) => addField(f, 'values')}
            >
              {valueFields.map((v) => (
                <div key={v.field} className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs">
                  <select
                    aria-label={`${v.field} 的聚合方式`}
                    className="h-6 rounded border border-input bg-background px-1 text-xs"
                    value={v.agg}
                    onChange={(e) =>
                      setValueFields(
                        valueFields.map((x) =>
                          x.field === v.field ? { ...x, agg: e.target.value as PivotAgg } : x,
                        ),
                      )
                    }
                  >
                    {AGG_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="flex-1 truncate">{v.field}</span>
                  <button
                    type="button"
                    aria-label={`移除数值 ${v.field}`}
                    onClick={() => removeField(v.field, 'values')}
                    className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </Well>

            <Well
              zone="filters"
              title="筛选列"
              hint="点击字段块选择保留的值"
              over={over === 'filters'}
              onOver={setOver}
              onDropField={(f) => addField(f, 'filters')}
            >
              {filters.map((f) => {
                const state = options[f.field];
                const expanded = openFilter === f.field;
                return (
                  <div key={f.field} className="space-y-1">
                    <div className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs">
                      <button
                        type="button"
                        className="flex-1 truncate text-left"
                        aria-expanded={expanded}
                        onClick={() => {
                          setOpenFilter(expanded ? null : f.field);
                          if (!state) void loadOptions(f.field);
                        }}
                      >
                        {f.field}
                        <span className="ml-1 text-muted-foreground">
                          {f.values.length === 0 ? '（全部值）' : `（已选 ${f.values.length} 个值）`}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`移除筛选 ${f.field}`}
                        onClick={() => removeField(f.field, 'filters')}
                        className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {expanded && (
                      <div className="rounded border border-border bg-muted/30 p-1.5 text-xs">
                        {state?.loading && <p className="px-1 py-1 text-muted-foreground">读取值…</p>}
                        {state?.error && <p className="px-1 py-1 text-destructive">{state.error}</p>}
                        {state && !state.loading && !state.error && (
                          <>
                            <div className="max-h-40 overflow-auto">
                              {state.values.length === 0 && (
                                <p className="px-1 py-1 text-muted-foreground">该列没有可选值。</p>
                              )}
                              {state.values.map((value) => {
                                // values 为空表示「全部值」，此时所有项视为已勾选
                                const selected = f.values.length === 0 ? state.values : f.values;
                                const checked = selected.includes(value);
                                // 至少要保留一个值，避免出现「空集」这种无法表达的状态
                                const lastOne = checked && selected.length === 1;
                                return (
                                  <label
                                    key={value}
                                    className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${
                                      lastOne ? 'opacity-60' : 'cursor-pointer hover:bg-accent'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      className="h-3.5 w-3.5 rounded border-input accent-primary"
                                      checked={checked}
                                      disabled={lastOne}
                                      onChange={() => {
                                        const next = checked
                                          ? selected.filter((v) => v !== value)
                                          : [...selected, value];
                                        // 勾满即回到「全部值」（不发送筛选条件）
                                        setFilters(
                                          filters.map((x) =>
                                            x.field === f.field
                                              ? { ...x, values: next.length === state.values.length ? [] : next }
                                              : x,
                                          ),
                                        );
                                      }}
                                    />
                                    <span className="truncate">{value}</span>
                                  </label>
                                );
                              })}
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/70 pt-1">
                              <span className="text-muted-foreground">至少保留一个值</span>
                              <button
                                type="button"
                                className="text-primary hover:underline"
                                onClick={() =>
                                  setFilters(filters.map((x) => (x.field === f.field ? { ...x, values: [] } : x)))
                                }
                              >
                                全部值
                              </button>
                            </div>
                            {state.truncated && (
                              <p className="mt-1 text-warning">该列去重值过多，仅显示前若干个</p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </Well>
          </section>
        </div>
      </div>
    </Modal>
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return `${err.message}（${err.detail}）`;
  return (err as Error).message;
}

/** 放置区：虚线框 + 拖拽高亮 + 内部字段块 */
function Well({
  zone,
  title,
  hint,
  over,
  onOver,
  onDropField,
  children,
}: {
  zone: ZoneKey;
  title: string;
  hint: string;
  over: boolean;
  onOver: (zone: ZoneKey | null) => void;
  onDropField: (field: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="shrink-0">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-xs font-medium">{title}</span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          onOver(zone);
        }}
        onDragLeave={() => onOver(null)}
        onDrop={(e) => {
          e.preventDefault();
          onOver(null);
          const field = e.dataTransfer.getData(FIELD_MIME) || e.dataTransfer.getData('text/plain');
          if (field) onDropField(field);
        }}
        className={`min-h-[42px] space-y-1 rounded border border-dashed p-1.5 transition-colors ${
          over ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function FieldChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs">
      <span className="flex-1 truncate">{label}</span>
      <button
        type="button"
        aria-label={`移除 ${label}`}
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const TH_CLS = 'border-b border-r border-border bg-muted px-2 py-1 text-left font-medium whitespace-nowrap';
const TD_CLS = 'border-b border-r border-border px-2 py-1 text-right tabular-nums whitespace-nowrap';

/** 透视矩阵表格：多级列头/行标签合并 + sticky 表头与首列 + 可加时显示行列总计 */
function PivotMatrixTable({ matrix, rowFieldNames }: { matrix: PivotMatrix; rowFieldNames: string[] }) {
  // 无行维度时给一个占位层级，保证表体每行都有对应的行头单元格
  const rowLabels = matrix.rowFieldCount === 0 ? matrix.rowLabels.map(() => ['合计']) : matrix.rowLabels;
  const rowLevels: MergedLabel[][] = mergeLabels(rowLabels);
  const colLevels: MergedLabel[][] = mergeLabels(matrix.columnHeaders.map((h) => h.labels));
  const showTotals = matrix.rowTotals !== null && matrix.colTotals !== null;

  if (matrix.columnHeaders.length === 0 || matrix.rowLabels.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">当前配置没有结果。</p>;
  }

  // 左上角：行维度字段名（无行维度时占位为「合计」）
  const cornerLabels = matrix.rowFieldCount === 0 ? ['合计'] : rowFieldNames;
  const rowDepth = matrix.rowDepth;

  return (
    <table className="border-separate border-spacing-0 text-xs">
      <thead>
        {colLevels.map((level, li) => (
          <tr key={li}>
            {li === 0 &&
              cornerLabels.map((name, i) => (
                <th
                  key={`${name}-${i}`}
                  rowSpan={matrix.columnDepth}
                  className={`${TH_CLS} sticky top-0 z-30 ${i === 0 ? 'left-0' : ''} text-center`}
                >
                  {name}
                </th>
              ))}
            {level.map((cell, ci) =>
              cell.covered ? null : (
                <th key={ci} colSpan={cell.span} className={`${TH_CLS} sticky top-0 z-20 text-center`}>
                  {cell.label}
                </th>
              ),
            )}
            {li === 0 && showTotals ? (
              <th rowSpan={matrix.columnDepth} className={`${TH_CLS} sticky top-0 z-20 text-center`}>
                总计
              </th>
            ) : null}
          </tr>
        ))}
      </thead>
      <tbody>
        {matrix.cells.map((rowCells, ri) => (
          <tr key={ri} className="hover:bg-accent/40">
            {rowLevels.map((level, li) => {
              const cell = level[ri];
              if (!cell || cell.covered) return null;
              return (
                <th
                  key={li}
                  rowSpan={cell.span}
                  className={`${TH_CLS} bg-card font-normal ${li === 0 ? 'sticky left-0 z-10' : ''}`}
                >
                  {cell.label}
                </th>
              );
            })}
            {rowCells.map((value, ci) => (
              <td key={ci} className={TD_CLS}>
                {value === null ? '' : fmt(value)}
              </td>
            ))}
            {showTotals ? <td className={`${TD_CLS} font-medium`}>{fmt(matrix.rowTotals![ri])}</td> : null}
          </tr>
        ))}
      </tbody>
      {showTotals ? (
        <tfoot>
          <tr>
            <th colSpan={rowDepth} className={`${TH_CLS} sticky left-0 z-10 text-center`}>
              总计
            </th>
            {matrix.colTotals!.map((value, i) => (
              <td key={i} className={`${TD_CLS} bg-muted font-medium`}>
                {fmt(value)}
              </td>
            ))}
            <td className={`${TD_CLS} bg-muted font-semibold`}>{fmt(matrix.grandTotal ?? 0)}</td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}
