import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../../api.js';
import { Button } from '../ui/button.js';
import { ErrorNote } from '../ui/error-note.js';
import { Modal } from '../ui/modal.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

type LogicalColumnType = 'string' | 'number' | 'date' | 'boolean';

interface ConfigColumn {
  name: string;
  /** DuckDB 原始类型名 */
  type: string;
  /** 当前指定的类型；null 表示使用原始类型 */
  configType: LogicalColumnType | null;
}

interface ColumnConfigResponse {
  name: string;
  columns: ConfigColumn[];
}

const TYPE_OPTIONS: Array<{ value: LogicalColumnType | ''; label: string }> = [
  { value: '', label: '原始类型' },
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'date', label: '日期' },
  { value: 'boolean', label: '布尔' },
];

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/** 列类型配置弹窗：逐列指定类型，保存到独立表（按模型名映射）。 */
export function ModelColumnConfigModal({
  open,
  modelName,
  onClose,
  onSaved,
}: {
  open: boolean;
  modelName: string;
  onClose: () => void;
  onSaved?: (overrideCount: number) => void;
}) {
  const [columns, setColumns] = useState<ConfigColumn[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !modelName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setColumns([]);
    void api
      .get<ColumnConfigResponse>(`/api/models/${encodeURIComponent(modelName)}/column-config`)
      .then((res) => {
        if (!cancelled) setColumns(res.columns);
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

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put<{ ok: boolean; count: number }>(
        `/api/models/${encodeURIComponent(modelName)}/column-config`,
        { body: { columns: columns.map((c) => ({ name: c.name, type: c.configType })) } },
      );
      onSaved?.(res.count);
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  }

  const overrideCount = columns.filter((c) => c.configType !== null).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`配置 · ${modelName}`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving || loading || columns.length === 0} onClick={() => void save()}>
            {saving ? '保存中…' : '保存配置'}
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted-foreground">
        为每一列指定类型（文本 / 数字 / 日期 / 布尔）。配置按模型名保存到独立表，并作用于数据预览、列统计、透视与仪表板；不会修改底层数据。
      </p>

      {loading && <p className="text-sm text-muted-foreground">读取列信息…</p>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {!loading && columns.length > 0 && (
        <>
          <div className="max-h-[55vh] overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <TableRow className="hover:bg-transparent">
                  <TableHead>列名</TableHead>
                  <TableHead className="w-40">原始类型</TableHead>
                  <TableHead className="w-40">指定类型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {columns.map((col, i) => (
                  <TableRow key={col.name}>
                    <TableCell className="font-mono text-xs">{col.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{col.type}</TableCell>
                    <TableCell>
                      <select
                        aria-label={`${col.name} 的类型`}
                        className="h-8 w-full rounded border border-input bg-background px-2 text-xs"
                        value={col.configType ?? ''}
                        onChange={(e) => {
                          const value = e.target.value as LogicalColumnType | '';
                          setColumns((prev) =>
                            prev.map((c, j) =>
                              j === i ? { ...c, configType: value === '' ? null : value } : c,
                            ),
                          );
                        }}
                      >
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            共 {columns.length} 列，已指定 {overrideCount} 列；选择「原始类型」即恢复该列的默认类型。
          </p>
        </>
      )}

      {!loading && !error && columns.length === 0 && (
        <p className="text-sm text-muted-foreground">该模型没有可配置的列。</p>
      )}
    </Modal>
  );
}
