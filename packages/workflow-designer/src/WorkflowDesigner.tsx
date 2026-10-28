import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toolbar } from '@/components/canvas/Toolbar';
import { NodePalette } from '@/components/canvas/NodePalette';
import { FlowCanvas } from '@/components/canvas/FlowCanvas';
import { NodeConfigPanel } from '@/components/panels/NodeConfigPanel';
import { BottomPanel } from '@/components/preview/BottomPanel';
import { RunErrorDialog } from '@/components/preview/RunErrorDialog';
import { DesignerHostProvider } from '@/context';
import { useWorkflowStore } from '@/store/workflowStore';
import { useInputSchemaSync } from '@/lib/useInputSchemaSync';
import type { WorkflowDesignerProps } from '@/adapters';

export function WorkflowDesigner({
  initialWorkflow,
  adapter,
  onExit,
  colorMode = 'dark',
}: WorkflowDesignerProps) {
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);
  const dirty = useWorkflowStore((s) => s.dirty);
  const setSchemaProbe = useWorkflowStore((s) => s.setSchemaProbe);
  const setRunHost = useWorkflowStore((s) => s.setRunHost);
  const probeSchema = adapter.probeSchema;
  const runWorkflow = adapter.runWorkflow;
  const subscribeRun = adapter.subscribeRun;
  const loadPreview = adapter.loadPreview;
  const unpinCache = adapter.unpinCache;

  useEffect(() => {
    loadWorkflow(initialWorkflow);
  }, [initialWorkflow, loadWorkflow]);

  // 把宿主的探测能力注入 store；卸载时撤销，避免残留指向过期宿主。
  useEffect(() => {
    setSchemaProbe(probeSchema ?? null);
    return () => setSchemaProbe(null);
  }, [probeSchema, setSchemaProbe]);

  // 把宿主的运行能力注入 store；三项能力需同时具备才启用运行态。
  useEffect(() => {
    setRunHost(
      runWorkflow && subscribeRun && loadPreview
        ? { runWorkflow, subscribeRun, loadPreview, ...(unpinCache ? { unpinCache } : {}) }
        : null,
    );
    return () => setRunHost(null);
  }, [runWorkflow, subscribeRun, loadPreview, unpinCache, setRunHost]);

  // 未保存时刷新 / 关闭页面给出浏览器原生提示
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 节点配置变更后防抖探测输入结构，刷新下游面板的可用列。
  useInputSchemaSync();

  return (
    <DesignerHostProvider value={{ adapter, onExit, colorMode }}>
      <TooltipProvider delayDuration={200}>
        <ReactFlowProvider>
          <div className="hust-designer flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
            <Toolbar />
            <NodePalette />
            <div className="flex min-h-0 flex-1">
              <NodeConfigPanel />
              <main className="flex min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  <FlowCanvas />
                </div>
                <BottomPanel />
              </main>
            </div>
            <RunErrorDialog />
          </div>
        </ReactFlowProvider>
      </TooltipProvider>
    </DesignerHostProvider>
  );
}
