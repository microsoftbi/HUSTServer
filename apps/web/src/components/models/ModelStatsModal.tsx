import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../../api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { ErrorNote } from '../ui/error-note.js';
import { Modal } from '../ui/modal.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

type StatCell = string | number | boolean | null;

interface ColumnStats {
  name: string;
  type: string;
  numeric: boolean;
  nonNull: number;
  nulls: number;
  distinct: number;
  min?: StatCell;
  max?: StatCell;
  avg?: number | null;
  median?: number | null;
  stddev?: number | null;
}

interface StatsResult {
  name: string;
  rowCount: number;
  columns: ColumnStats[];
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/** 整数千分位；小数按 4 位有效数字取整并去掉尾随 0 */
function fmtNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  const s = v.toPrecision(4);
  if (s.includes('e')) return String(v);
  const [int, frac] = s.replace(/0+$/, '').replace(/\.$/, '').split('.');
  const grouped = Number(int).toLocaleString('en-US');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** 单元格值：空值统一显示破折号 */
function fmtCell(v: StatCell | undefined): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** 列统计弹窗：一列一行，第一列列名，第二列统计胶囊。 */
export function ModelStatsModal({
  open,
  modelName,
  onClose,
}: {
  open: boolean;
  modelName: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StatsResult | null>(null);

  useEffect(() => {
    if (!open || !modelName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    void api
      .post<StatsResult>('/api/models/stats', { body: { name: modelName } })
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, modelName]);

  const numericCount = result?.columns.filter((c) => c.numeric).length ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`列统计 · ${modelName}`}
      className="max-w-3xl"
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {loading && <p className="text-sm text-muted-foreground">统计中…（全表扫描，列多或数据量大时较慢）</p>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {result && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            共 {fmtNumber(result.rowCount)} 行 · {result.columns.length} 列 · 其中 {numericCount} 个数值列
          </p>
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-56">列名</TableHead>
                  <TableHead>统计信息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.columns.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="align-top">
                      <div className="font-mono text-xs">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.type}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge>非空 {fmtNumber(c.nonNull)}</Badge>
                        <Badge tone={c.nulls > 0 ? 'warning' : 'neutral'}>空值 {fmtNumber(c.nulls)}</Badge>
                        <Badge>不重复 {fmtNumber(c.distinct)}</Badge>
                        {c.numeric && (
                          <>
                            <Badge tone="primary">最小 {fmtCell(c.min)}</Badge>
                            <Badge tone="primary">最大 {fmtCell(c.max)}</Badge>
                            <Badge tone="primary">平均 {fmtNumber(c.avg)}</Badge>
                            <Badge tone="primary">中位数 {fmtNumber(c.median)}</Badge>
                            <Badge tone="primary">标准差 {fmtNumber(c.stddev)}</Badge>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </Modal>
  );
}
