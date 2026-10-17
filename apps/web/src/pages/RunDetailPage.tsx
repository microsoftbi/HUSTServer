import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ListTree, Terminal } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import type { RunSummary } from '../types.js';

interface RunNodeResult {
  id: number;
  run_id: string;
  node_id: string;
  name: string | null;
  kind: string | null;
  status: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  updated_at: number;
}

interface LogItem {
  id: number;
  ts: number;
  level: string;
  node_id: string | null;
  message: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过',
};

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  queued: 'neutral',
  running: 'primary',
  success: 'success',
  error: 'danger',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'neutral',
};

/** 处于这些状态的运行需要主动轮询刷新；到达终态后停止。 */
const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running']);
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 2000;

export function RunDetailPage() {
  const { id = '' } = useParams();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [nodes, setNodes] = useState<RunNodeResult[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 已拉取日志的最大 id：轮询时作为 after 游标只取增量，避免重复追加
  const logCursor = useRef(0);

  const loadSnapshot = useCallback(async () => {
    try {
      const [detail, logRes] = await Promise.all([
        api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`),
        api.get<{ items: LogItem[] }>(`/api/runs/${id}/logs?limit=1000`),
      ]);
      setRun(detail.run);
      setNodes(detail.nodes);
      setLogs(logRes.items);
      logCursor.current = logRes.items.reduce((max, l) => Math.max(max, l.id), 0);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  const refreshDetail = useCallback(async () => {
    try {
      const detail = await api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`);
      setRun(detail.run);
      setNodes(detail.nodes);
    } catch {
      /* 忽略瞬时错误，下一轮轮询会再拉一次 */
    }
  }, [id]);

  /** 增量拉取运行状态与新增日志（按 id 游标），失败时保留上一轮数据。 */
  const refreshProgress = useCallback(async () => {
    try {
      const [detail, logRes] = await Promise.all([
        api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`),
        api.get<{ items: LogItem[] }>(`/api/runs/${id}/logs?after=${logCursor.current}&limit=1000`),
      ]);
      setRun(detail.run);
      setNodes(detail.nodes);
      if (logRes.items.length > 0) {
        logCursor.current = logRes.items.reduce((max, l) => Math.max(max, l.id), logCursor.current);
        setLogs((prev) => [...prev, ...logRes.items]);
      }
      setError(null);
    } catch {
      /* 忽略瞬时错误，下一轮轮询会再拉一次 */
    }
  }, [id]);

  const polling = run === null || ACTIVE_STATUSES.has(run.status);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  // 运行进行中时主动轮询日志与状态；到达终态（成功/失败/取消）后自动停止。
  // 首屏 run 尚未加载时也轮询，确保快照请求失败后仍能自愈。
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => void refreshProgress(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [polling, refreshProgress]);

  // SSE 只承担节点结果 / 运行状态的即时更新与结束通知；日志统一由上面的轮询增量拉取。
  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/events`);
    setLive(true);

    // node-result / run-status 的具体字段由引擎定义，直接回拉快照最稳妥
    es.addEventListener('node-result', () => void refreshDetail());
    es.addEventListener('run-status', () => void refreshDetail());
    es.addEventListener('done', () => {
      setLive(false);
      es.close();
      void loadSnapshot();
    });
    es.onerror = () => {
      setLive(false);
      es.close();
    };

    return () => es.close();
  }, [id, loadSnapshot, refreshDetail]);

  return (
    <div className="space-y-4">
      <PageHeader title="运行详情" description={`运行 ID：${id}`}>
        {live && (
          <Badge dot tone="primary">
            实时
          </Badge>
        )}
        <Button asChild variant="outline">
          <Link to={`/workflows/${run?.workflow_id ?? ''}`}>
            <ArrowLeft />
            返回工作流
          </Link>
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}
      {run?.error && <ErrorNote>错误：{run.error}</ErrorNote>}

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>节点结果</CardTitle>
            <CardDescription>按节点展示执行状态、行数与耗时。</CardDescription>
          </div>
          {run && (
            <Badge dot tone={STATUS_TONE[run.status] ?? 'neutral'}>
              {STATUS_LABEL[run.status] ?? run.status}
            </Badge>
          )}
        </CardHeader>
        {nodes.length === 0 ? (
          <EmptyState icon={ListTree} title="暂无节点结果" description="节点开始执行后会在这里实时刷新。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>节点</TableHead>
                <TableHead className="w-28">类型</TableHead>
                <TableHead className="w-32">状态</TableHead>
                <TableHead className="w-24 text-right">行数</TableHead>
                <TableHead className="w-28 text-right">耗时</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((n) => (
                <TableRow key={n.node_id}>
                  <TableCell className="font-medium">{n.name ?? n.node_id}</TableCell>
                  <TableCell className="text-muted-foreground">{n.kind ?? '-'}</TableCell>
                  <TableCell>
                    <Badge dot tone={STATUS_TONE[n.status] ?? 'neutral'}>
                      {STATUS_LABEL[n.status] ?? n.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{n.row_count ?? '-'}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {n.duration_ms != null ? `${n.duration_ms} ms` : '-'}
                  </TableCell>
                  <TableCell className="text-destructive">{n.error ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>执行日志</CardTitle>
          <Badge tone="neutral">{logs.length} 条</Badge>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
            {logs.map((l) => (
              <div key={l.id}>
                <span className="text-muted-foreground">[{new Date(l.ts).toLocaleTimeString()}]</span>{' '}
                <span className={l.level === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{l.level}</span>{' '}
                {l.node_id && <span className="text-primary">{l.node_id} </span>}
                <span>{l.message}</span>
              </div>
            ))}
            {logs.length === 0 && <div className="text-muted-foreground">暂无日志。</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
