import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api, ApiClientError } from '../../api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { EmptyState } from '../ui/empty-state.js';
import { ErrorNote } from '../ui/error-note.js';
import { Modal } from '../ui/modal.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

interface LoginLogDto {
  id: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

const LIMIT = 20;

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/** 登录日志弹窗：展示指定用户最近的登录记录（成功与失败）。 */
export function LoginLogsModal({
  open,
  user,
  onClose,
}: {
  open: boolean;
  user: { id: string; username: string } | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LoginLogDto[] | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLogs(null);
    void api
      .get<{ logs: LoginLogDto[] }>(`/api/admin/users/${user.id}/login-logs?limit=${LIMIT}`)
      .then((res) => {
        if (!cancelled) setLogs(res.logs);
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
  }, [open, user]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`登录日志 · ${user?.username ?? ''}`}
      className="max-w-2xl"
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {logs && logs.length === 0 && (
        <EmptyState
          icon={History}
          title="暂无登录记录"
          description="仅记录本次上线后的登录，历史登录无法追溯。"
        />
      )}

      {logs && logs.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">最近 {logs.length} 条记录</p>
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-44">时间</TableHead>
                  <TableHead className="w-24">结果</TableHead>
                  <TableHead className="w-36">IP</TableHead>
                  <TableHead>客户端</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(l.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {l.success ? (
                        <Badge dot tone="success">
                          成功
                        </Badge>
                      ) : (
                        <div className="space-y-1">
                          <Badge dot tone="danger">
                            失败
                          </Badge>
                          {l.reason && <div className="text-xs text-muted-foreground">{l.reason}</div>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{l.ip ?? '—'}</TableCell>
                    <TableCell
                      className="max-w-[16rem] truncate text-xs text-muted-foreground"
                      title={l.user_agent ?? ''}
                    >
                      {l.user_agent ?? '—'}
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
