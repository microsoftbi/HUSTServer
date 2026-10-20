import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Database,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Table2,
  Trash2,
} from 'lucide-react';
import { api, ApiClientError } from '../api.js';
import { useAuth } from '../auth.js';
import { CreateModelModal, type CreatedModel } from '../components/models/CreateModelModal.js';
import { ModelColumnConfigModal } from '../components/models/ModelColumnConfigModal.js';
import { ModelStatsModal } from '../components/models/ModelStatsModal.js';
import { PivotBuilder } from '../components/pivot/PivotBuilder.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Modal } from '../components/ui/modal.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';

interface ModelColumn {
  name: string;
  type: string;
}

interface ModelItem {
  name: string;
  sourceKind: 'csv' | 'excel' | 'sqlserver' | 'audit';
  sourceRef: {
    resourcePath?: string;
    format?: string;
    connectionId?: string;
    object?: string;
    query?: string;
  };
  ownerId: string | null;
  loadedAt: number;
  rowCount: number;
  columns: ModelColumn[];
}

type ModelCell = string | number | boolean | null;

interface ModelQueryResult {
  columns: ModelColumn[];
  rows: ModelCell[][];
  truncated: boolean;
}

/** 预览弹窗一次读取的行数上限（服务端默认与上限均为 1000） */
const PREVIEW_LIMIT = 1000;

/** 预览弹窗状态：loading / error / result 三态互斥 */
interface PreviewState {
  name: string;
  loading: boolean;
  error: string | null;
  result: ModelQueryResult | null;
}

const SOURCE_LABEL: Record<ModelItem['sourceKind'], string> = {
  csv: 'CSV 文件',
  excel: 'Excel 文件',
  sqlserver: 'SQL Server',
  audit: '系统审计',
};

function sourceText(m: ModelItem): string {
  if (m.sourceKind === 'sqlserver') return m.sourceRef.object ?? m.sourceRef.query ?? '—';
  if (m.sourceKind === 'audit') return '审计日志';
  return m.sourceRef.resourcePath ?? '—';
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/** 预览单元格：空值统一显示灰色破折号 */
function PreviewCell({ value }: { value: ModelCell | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'boolean') return <>{value ? 'true' : 'false'}</>;
  return <>{String(value)}</>;
}

export function ModelsPage() {
  const { hasCap } = useAuth();
  const canManage = hasCap('job');
  const [items, setItems] = useState<ModelItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pivotModel, setPivotModel] = useState<ModelItem | null>(null);
  const [statsModel, setStatsModel] = useState<ModelItem | null>(null);
  const [configModel, setConfigModel] = useState<ModelItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: ModelItem[] }>('/api/models');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rename(m: ModelItem): Promise<void> {
    const next = window.prompt('新的模型名（字母或下划线开头，仅含字母数字下划线）', m.name);
    if (next === null) return;
    const newName = next.trim();
    if (!newName || newName === m.name) return;
    if (!window.confirm(`确认把模型「${m.name}」重命名为「${newName}」？已引用旧名的仪表板会失效。`)) return;
    try {
      await api.request('PATCH', `/api/models/${encodeURIComponent(m.name)}`, { body: { newName } });
      await load();
      window.alert(`已重命名为「${newName}」。注意：已引用旧名「${m.name}」的仪表板将失效。`);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function remove(m: ModelItem): Promise<void> {
    if (!window.confirm(`确认删除模型「${m.name}」？该操作不可恢复。`)) return;
    try {
      await api.del(`/api/models/${encodeURIComponent(m.name)}`);
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  /** 预览：读取模型前 1000 行（服务端默认上限即 1000）。 */
  async function openPreview(m: ModelItem): Promise<void> {
    setPreview({ name: m.name, loading: true, error: null, result: null });
    try {
      const result = await api.post<ModelQueryResult>('/api/models/query', {
        body: { name: m.name, limit: PREVIEW_LIMIT },
      });
      setPreview({ name: m.name, loading: false, error: null, result });
    } catch (err) {
      setPreview({ name: m.name, loading: false, error: errText(err), result: null });
    }
  }

  /** 新建模型成功后：关闭弹窗、刷新列表、提示载入结果。 */
  async function handleCreated(created: CreatedModel): Promise<void> {
    setCreating(false);
    setNotice(`已载入模型「${created.name}」（${created.rowCount} 行）`);
    await load();
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="数据模型"
        description="模型可由 Job 编排的「加载成模型」步骤产生，也可在此直接新建；加载后可在仪表板中作为数据集使用。"
      >
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw />
          {loading ? '刷新中…' : '刷新'}
        </Button>
        {canManage && (
          <Button
            onClick={() => {
              setNotice(null);
              setCreating(true);
            }}
          >
            <Plus />
            新建模型
          </Button>
        )}
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>
      )}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={Database}
            title={loading ? '加载中…' : '暂无数据模型'}
            description={
              loading ? undefined : '模型可由 Job 编排的「加载成模型」步骤产生，也可在此直接新建。'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>模型名</TableHead>
                <TableHead>来源</TableHead>
                <TableHead className="w-24">行数</TableHead>
                <TableHead className="w-24">列数</TableHead>
                <TableHead className="w-48">加载时间</TableHead>
                <TableHead className="w-[18rem] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((m) => (
                <TableRow key={m.name}>
                  <TableCell className="font-mono">{m.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="primary">{SOURCE_LABEL[m.sourceKind]}</Badge>
                      <span className="text-xs text-muted-foreground">{sourceText(m)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.rowCount}</TableCell>
                  <TableCell className="text-muted-foreground">{m.columns.length}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(m.loadedAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="ml-auto flex max-w-[16rem] flex-wrap items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void openPreview(m)}>
                        <Eye />
                        数据预览
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setPivotModel(m)}>
                        <Table2 />
                        透视
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setStatsModel(m)}>
                        <BarChart3 />
                        统计
                      </Button>
                      {canManage && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setConfigModel(m)}>
                            <SlidersHorizontal />
                            配置
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void rename(m)}>
                            <Pencil />
                            重命名
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => void remove(m)}
                          >
                            <Trash2 />
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {items.length > 0 && <p className="px-1 text-xs text-muted-foreground">共 {items.length} 个模型</p>}

      <CreateModelModal
        open={creating}
        existingNames={items.map((m) => m.name)}
        onClose={() => setCreating(false)}
        onCreated={(created) => void handleCreated(created)}
      />

      <PivotBuilder
        open={pivotModel !== null}
        modelName={pivotModel?.name ?? ''}
        columns={pivotModel?.columns ?? []}
        onClose={() => setPivotModel(null)}
      />

      <ModelStatsModal
        open={statsModel !== null}
        modelName={statsModel?.name ?? ''}
        onClose={() => setStatsModel(null)}
      />

      <ModelColumnConfigModal
        open={configModel !== null}
        modelName={configModel?.name ?? ''}
        onClose={() => setConfigModel(null)}
        onSaved={(count) => {
          setNotice(`已保存模型「${configModel?.name ?? ''}」的列类型配置（${count} 列）`);
          void load();
        }}
      />

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? `数据预览 · ${preview.name}` : '数据预览'}
        className="max-w-4xl"
        footer={
          <Button variant="outline" onClick={() => setPreview(null)}>
            关闭
          </Button>
        }
      >
        {preview?.loading && <p className="text-sm text-muted-foreground">读取中…</p>}
        {preview?.error && <ErrorNote>{preview.error}</ErrorNote>}
        {preview?.result && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {preview.result.columns.length} 列 · 显示 {preview.result.rows.length} 行
              {preview.result.truncated ? `（仅显示前 ${PREVIEW_LIMIT} 行）` : ''}
            </p>
            {preview.result.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">该模型暂无数据。</p>
            ) : (
              <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                    <TableRow className="hover:bg-transparent">
                      {preview.result.columns.map((col, i) => (
                        <TableHead key={`${col.name}-${i}`} className="whitespace-nowrap">
                          {col.name}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.result.rows.map((row, ri) => (
                      <TableRow key={ri}>
                        {preview.result!.columns.map((_, ci) => (
                          <TableCell key={ci} className="whitespace-nowrap text-xs">
                            <PreviewCell value={row[ci]} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
