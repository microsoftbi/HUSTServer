import { Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Field, Input, Select } from '../../../components/ui/input.js';
import type { JobNodeMode, JobOnFailure, WorkflowSummary } from '../../../types.js';
import { disabledKeys } from '../lib/graph.js';
import { JOB_NODE_META, nodeIssues } from '../lib/nodeMeta.js';
import { useJobEditorStore } from '../store/jobEditorStore.js';
import { LoadModelNodeForm } from '../config/LoadModelNodeForm.js';
import { SqlNodeForm } from '../config/SqlNodeForm.js';
import { WorkflowNodeForm } from '../config/WorkflowNodeForm.js';

export interface JobInspectorProps {
  workflows: WorkflowSummary[];
  connections: Array<{ id: string; name: string; type: string }>;
  resourceFiles: Array<{ name: string; path: string }>;
  locked?: boolean;
}

export function JobInspector({
  workflows,
  connections,
  resourceFiles,
  locked = false,
}: JobInspectorProps) {
  const nodes = useJobEditorStore((s) => s.nodes);
  const edges = useJobEditorStore((s) => s.edges);
  const selectedKey = useJobEditorStore((s) => s.selectedKey);
  const updateNode = useJobEditorStore((s) => s.updateNode);
  const removeNodes = useJobEditorStore((s) => s.removeNodes);

  const node = nodes.find((n) => n.key === selectedKey);

  if (!node) {
    return (
      <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-card/40 p-3">
        <div className="text-xs font-semibold text-muted-foreground">节点属性</div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          选择画布上的节点后可编辑其配置。Job 的名称、描述与调度在顶部「设置」中修改。
        </p>
        <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
          从顶部组件区添加节点，或把节点拖到画布中继续编排。
        </p>
      </aside>
    );
  }

  const meta = JOB_NODE_META[node.type];
  const Icon = meta.icon;
  const issues = nodeIssues(node);
  const blocked = node.mode !== 'disable' && disabledKeys(nodes, edges).has(node.key);
  const patchConfig = (patch: Record<string, unknown>) => updateNode(node.key, { config: patch });

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <span className={`flex size-6 items-center justify-center rounded text-white ${meta.accent}`}>
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{meta.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">节点 {node.key}</div>
        </div>
      </div>

      {blocked && (
        <div className="flex items-start gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          上游存在禁用节点，本节点不会执行。
        </div>
      )}
      {issues.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1.5 text-[11px] text-[var(--warning)]">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          配置未完成：{issues.join('、')}
        </div>
      )}

      <Field label="节点名称">
        <Input
          value={node.name}
          disabled={locked}
          onChange={(event) => updateNode(node.key, { name: event.target.value })}
        />
      </Field>

      {node.type === 'workflow' && (
        <WorkflowNodeForm
          config={node.config}
          workflows={workflows}
          disabled={locked}
          onChange={patchConfig}
        />
      )}
      {node.type === 'sql' && (
        <SqlNodeForm
          config={node.config}
          connections={connections}
          disabled={locked}
          onChange={patchConfig}
        />
      )}
      {node.type === 'load_model' && (
        <LoadModelNodeForm
          config={node.config}
          connections={connections}
          resourceFiles={resourceFiles}
          disabled={locked}
          onChange={patchConfig}
        />
      )}

      <Field label="失败策略">
        <Select
          value={node.onFailure}
          disabled={locked}
          onChange={(event) => updateNode(node.key, { onFailure: event.target.value as JobOnFailure })}
        >
          <option value="abort">中止（跳过受影响的下游）</option>
          <option value="continue">继续（记录失败并执行下游）</option>
        </Select>
      </Field>

      <Field label="运行模式" hint="禁用会把全部下游一起禁用；跳过只跳过当前节点。">
        <Select
          value={node.mode}
          disabled={locked}
          onChange={(event) => updateNode(node.key, { mode: event.target.value as JobNodeMode })}
        >
          <option value="run">正常运行</option>
          <option value="skip">跳过（仅当前节点）</option>
          <option value="disable">禁用（含全部下游）</option>
        </Select>
      </Field>

      <Button
        variant="ghost"
        size="sm"
        disabled={locked}
        className="mt-auto justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => removeNodes([node.key])}
      >
        <Trash2 />
        删除节点
      </Button>
    </aside>
  );
}
