import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  InputCsvPanel,
  InputExcelPanel,
  InputSqlServerPanel,
} from '@/components/panels/InputPanels';
import {
  AggregationPanel,
  FilterPanel,
  JoinPanel,
  SelectPanel,
  SortPanel,
  UnionPanel,
} from '@/components/panels/TransformPanels';
import {
  OutputCsvPanel,
  OutputDataModelPanel,
  OutputExcelPanel,
  OutputSqlServerPanel,
} from '@/components/panels/OutputPanels';
import {
  CleansingPanel,
  FormulaPanel,
  SamplePanel,
  UniquePanel,
} from '@/components/panels/PrepPanels';
import {
  CrossTabPanel,
  RunningTotalPanel,
  TextToColumnsPanel,
  TransposePanel,
} from '@/components/panels/PivotPanels';
import { CATEGORY_ACCENT, getNodeMeta } from '@/lib/nodeMeta';
import { useWorkflowStore } from '@/store/workflowStore';
import { cn } from '@/lib/utils';
import type { WorkflowNode } from '@/types';

function ConfigForm({ node }: { node: WorkflowNode }) {
  switch (node.kind) {
    case 'inputCsv':
      return <InputCsvPanel node={node} />;
    case 'inputExcel':
      return <InputExcelPanel node={node} />;
    case 'inputSqlServer':
      return <InputSqlServerPanel node={node} />;
    case 'select':
      return <SelectPanel node={node} />;
    case 'filter':
      return <FilterPanel node={node} />;
    case 'join':
      return <JoinPanel node={node} />;
    case 'union':
      return <UnionPanel node={node} />;
    case 'aggregation':
      return <AggregationPanel node={node} />;
    case 'sort':
      return <SortPanel node={node} />;
    case 'formula':
      return <FormulaPanel node={node} />;
    case 'unique':
      return <UniquePanel node={node} />;
    case 'sample':
      return <SamplePanel node={node} />;
    case 'cleansing':
      return <CleansingPanel node={node} />;
    case 'runningTotal':
      return <RunningTotalPanel node={node} />;
    case 'textToColumns':
      return <TextToColumnsPanel node={node} />;
    case 'crossTab':
      return <CrossTabPanel node={node} />;
    case 'transpose':
      return <TransposePanel node={node} />;
    case 'dataModel':
      return <OutputDataModelPanel node={node} />;
    case 'outputCsv':
      return <OutputCsvPanel node={node} />;
    case 'outputExcel':
      return <OutputExcelPanel node={node} />;
    case 'outputSqlServer':
      return <OutputSqlServerPanel node={node} />;
    default:
      return null;
  }
}

/** 左侧节点配置面板：仅承载参数配置（数据预览见底部面板）。 */
export function NodeConfigPanel() {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === s.selectedNodeId) ?? null);
  const updateNodeName = useWorkflowStore((s) => s.updateNodeName);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const selectNode = useWorkflowStore((s) => s.selectNode);

  if (!node) {
    return (
      <aside className="flex w-80 shrink-0 flex-col items-center justify-center gap-2 border-r border-border bg-card/40 px-6 text-center">
        <div className="text-sm font-medium text-muted-foreground">未选择节点</div>
        <div className="text-xs text-muted-foreground/80">
          点击画布上的节点以配置参数并查看该阶段数据
        </div>
      </aside>
    );
  }

  const meta = getNodeMeta(node.kind);
  const Icon = meta.icon;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <div
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md text-white',
            CATEGORY_ACCENT[meta.category],
          )}
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <Input
            value={node.name}
            onChange={(event) => updateNodeName(node.id, event.target.value)}
            className="h-7 px-1.5 text-sm font-medium"
          />
          <div className="mt-0.5 px-1.5 text-[10px] text-muted-foreground">
            {meta.label} · {node.id}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="删除节点"
          onClick={() => removeNode(node.id)}
        >
          <Trash2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          title="关闭"
          onClick={() => selectNode(null)}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ConfigForm node={node} />
      </div>
    </aside>
  );
}
