import { TableProperties } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataPreview } from '@/components/preview/DataPreview';
import { RunLogView } from '@/components/preview/RunLog';
import { useWorkflowStore } from '@/store/workflowStore';

/** 底部结果面板：选项卡切换「数据预览 / 运行日志」。 */
export function BottomPanel() {
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);

  return (
    <div className="flex h-72 shrink-0 flex-col border-t border-border bg-card/40">
      <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <TabsList>
            <TabsTrigger value="preview">数据预览</TabsTrigger>
            <TabsTrigger value="log">运行日志</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="preview" className="min-h-0">
          {selectedNodeId ? (
            <DataPreview nodeId={selectedNodeId} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <TableProperties className="size-6 text-muted-foreground/60" />
              <div className="text-sm font-medium">未选择节点</div>
              <div className="text-xs text-muted-foreground">
                点击画布上的节点以查看该阶段输出数据
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="log" className="min-h-0">
          <RunLogView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
