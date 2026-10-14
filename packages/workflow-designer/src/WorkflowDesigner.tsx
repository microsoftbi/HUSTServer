import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toolbar } from '@/components/canvas/Toolbar';
import { NodePalette } from '@/components/canvas/NodePalette';
import { FlowCanvas } from '@/components/canvas/FlowCanvas';
import { NodeConfigPanel } from '@/components/panels/NodeConfigPanel';
import { DesignerHostProvider } from '@/context';
import { useWorkflowStore } from '@/store/workflowStore';
import type { WorkflowDesignerProps } from '@/adapters';

export function WorkflowDesigner({ initialWorkflow, adapter, onExit }: WorkflowDesignerProps) {
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);

  useEffect(() => {
    loadWorkflow(initialWorkflow);
  }, [initialWorkflow, loadWorkflow]);

  return (
    <DesignerHostProvider value={{ adapter, onExit }}>
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
              </main>
            </div>
          </div>
        </ReactFlowProvider>
      </TooltipProvider>
    </DesignerHostProvider>
  );
}
