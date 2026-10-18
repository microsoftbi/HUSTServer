import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Field, Select } from '../components/ui/input.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';

type AuditAction = 'create' | 'update' | 'delete' | 'other' | 'login' | 'login_failed';
type AuditResource =
  | 'workflow'
  | 'dashboard'
  | 'model'
  | 'resource'
  | 'connection'
  | 'job'
  | 'user'
  | 'auth';

interface AuditItem {
  id: string;
  username: string;
  action: AuditAction;
  resource: AuditResource;
  resource_name: string | null;
  description: string;
  created_at: number;
}

interface AuditResponse {
  total: number;
  limit: number;
  offset: number;
  items: AuditItem[];
}

const PAGE_SIZE = 50;

const ACTION_OPTIONS: AuditAction[] = ['create', 'update', 'delete', 'other', 'login', 'login_failed'];

const ACTION_LABELS: Record<AuditAction, string> = {
  create: '创建',
  update: '修改',
  delete: '删除',
  other: '其它',
  login: '登录',
  login_failed: '登录失败',
};

const ACTION_TONE: Record<AuditAction, 'primary' | 'neutral' | 'danger' | 'warning'> = {
  create: 'primary',
  update: 'neutral',
  delete: 'danger',
  other: 'warning',
  login: 'primary',
  login_failed: 'danger',
};

const RESOURCE_OPTIONS: AuditResource[] = [
  'workflow',
  'dashboard',
  'model',
  'resource',
  'connection',
  'job',
  'user',
  'auth',
];

const RESOURCE_LABELS: Record<AuditResource, string> = {
  workflow: '工作流',
  dashboard: '仪表板',
  model: '数据模型',
  resource: '资源管理',
  connection: '连接',
  job: 'Job',
  user: '用户',
  auth: '登录认证',
};

export function AuditPage() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<AuditAction | ''>('');
  const [resource, setResource] = useState<AuditResource | ''>('');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      if (action) params.set('action', action);
      if (resource) params.set('resource', resource);
      const res = await api.get<AuditResponse>(`/api/admin/audit-logs?${params.toString()}`);
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, action, resource]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeAction(value: AuditAction | ''): void {
    setAction(value);
    setPage(0);
  }

  function changeResource(value: AuditResource | ''): void {
    setResource(value);
    setPage(0);
  }

  function reset(): void {
    setAction('');
    setResource('');
    setPage(0);
  }

  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div className="space-y-4">
      <PageHeader
        title="系统审计"
        description="记录谁在什么时间对哪些资源做了什么操作（仅记录本功能上线后的操作）。"
      >
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw />
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="资源类型" className="w-44">
          <Select value={resource} onChange={(e) => changeResource(e.target.value as AuditResource | '')}>
            <option value="">全部</option>
            {RESOURCE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {RESOURCE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="操作类型" className="w-44">
          <Select value={action} onChange={(e) => changeAction(e.target.value as AuditAction | '')}>
            <option value="">全部</option>
            {ACTION_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="outline" disabled={loading} onClick={reset}>
          重置
        </Button>
      </div>

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={loading ? '加载中…' : '暂无审计记录'}
            description={loading ? undefined : '对工作流、仪表板、资源等执行操作后，这里会显示相应记录。'}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-44">时间</TableHead>
                  <TableHead className="w-32">用户</TableHead>
                  <TableHead className="w-24">操作</TableHead>
                  <TableHead className="w-28">资源</TableHead>
                  <TableHead className="w-56">资源名</TableHead>
                  <TableHead>描述</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(item.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">{item.username}</TableCell>
                    <TableCell>
                      <Badge tone={ACTION_TONE[item.action] ?? 'neutral'}>{ACTION_LABELS[item.action] ?? item.action}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone="neutral">{RESOURCE_LABELS[item.resource] ?? item.resource}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{item.resource_name || '—'}</TableCell>
                    <TableCell className="whitespace-normal break-words text-muted-foreground">
                      {item.description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between gap-2 border-t border-border/70 px-4 py-2 text-xs text-muted-foreground">
              <span>共 {total} 条</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hasPrev || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hasNext || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
