import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getNodeMeta } from '@/lib/nodeMeta';
import { formatDuration } from '@/lib/format';
import { useWorkflowStore } from '@/store/workflowStore';

/** 运行失败时弹出的错误详情模态窗。 */
export function RunErrorDialog() {
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const nodeStatus = useWorkflowStore((s) => s.nodeStatus);
  const nodeResults = useWorkflowStore((s) => s.nodeResults);
  const nodes = useWorkflowStore((s) => s.nodes);
  const [dismissed, setDismissed] = useState(false);

  // 新一次运行开始时复位关闭状态，便于失败后再次弹出
  useEffect(() => {
    if (runStatus === 'running') setDismissed(false);
  }, [runStatus]);

  const open = runStatus === 'error' && !dismissed;

  const failedId = Object.keys(nodeStatus).find((id) => nodeStatus[id] === 'error');
  const failedNode = nodes.find((n) => n.id === failedId) ?? null;
  const result = failedId ? nodeResults[failedId] : undefined;

  if (!failedNode) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && setDismissed(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" />
            工作流执行失败
          </DialogTitle>
          <DialogDescription>运行已在出错节点处停止，其后节点已跳过。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <div className="text-[11px] text-muted-foreground">出错节点</div>
            <div className="font-medium">{failedNode.name}</div>
            <div className="text-[11px] text-muted-foreground">
              {getNodeMeta(failedNode.kind).label} · {failedNode.id}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="text-[11px] text-muted-foreground">错误信息</div>
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[12px] text-destructive">
              {result?.error?.trim() || '未知错误'}
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground">
            耗时：{formatDuration(result?.durationMs ?? 0)}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" onClick={() => setDismissed(true)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
