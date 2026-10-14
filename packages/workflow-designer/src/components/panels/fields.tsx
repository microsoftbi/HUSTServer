import { useCallback, useMemo, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWorkflowStore } from '@/store/workflowStore';
import { upstreamNodeId, upstreamNodeIds } from '@/lib/graph';
import { deriveNodeColumns } from '@/lib/schema';
import { cn } from '@/lib/utils';
import type { ColumnMeta, WorkflowNode } from '@/types';

/** Radix Select 不允许空字符串作为 value，用哨兵值表示「无」。 */
export const NONE_VALUE = '__none__';

/** 所有节点配置面板的统一入参。 */
export interface PanelProps {
  node: WorkflowNode;
}

/** 配置读写 hook：读取当前节点配置，并支持合并式补丁更新。 */
export function useNodeConfig<T extends object>(
  node: WorkflowNode,
): [T, (patch: Partial<T>) => void] {
  const updateNodeConfig = useWorkflowStore((s) => s.updateNodeConfig);
  const patch = useCallback(
    (p: Partial<T>) => {
      updateNodeConfig(node.id, { ...node.config, ...p });
    },
    [node.id, node.config, updateNodeConfig],
  );
  return [node.config as unknown as T, patch];
}

/** 读取某输入端口的上游列：输入节点来自探测结果，转换节点按配置推导。 */
export function useInputCols(nodeId: string, handle = 'in'): ColumnMeta[] {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const nodeColumns = useWorkflowStore((s) => s.nodeColumns);
  const inputSchemas = useWorkflowStore((s) => s.inputSchemas);

  const derived = useMemo(
    () => deriveNodeColumns(nodes, edges, { ...nodeColumns, ...inputSchemas }),
    [nodes, edges, nodeColumns, inputSchemas],
  );

  return useMemo(() => {
    const upstream = upstreamNodeId(edges, nodeId, handle);
    return upstream ? derived[upstream] ?? [] : [];
  }, [derived, edges, nodeId, handle]);
}

/** 读取某输入端口上连接的多路上游列（按连线顺序），用于 Union 等单端口多输入节点。 */
export function useInputColsList(
  nodeId: string,
  handle = 'in',
): { nodeId: string; columns: ColumnMeta[] }[] {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const nodeColumns = useWorkflowStore((s) => s.nodeColumns);
  const inputSchemas = useWorkflowStore((s) => s.inputSchemas);

  const derived = useMemo(
    () => deriveNodeColumns(nodes, edges, { ...nodeColumns, ...inputSchemas }),
    [nodes, edges, nodeColumns, inputSchemas],
  );

  return useMemo(
    () =>
      upstreamNodeIds(edges, nodeId, handle).map((id) => ({
        nodeId: id,
        columns: derived[id] ?? [],
      })),
    [derived, edges, nodeId, handle],
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label !== undefined && <Label>{label}</Label>}
      {children}
      {hint !== undefined && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}

/** 列下拉：候选项来自上游 schema；当前值若不在候选中也会保留展示。 */
export function ColumnSelect({
  value,
  onChange,
  columns,
  placeholder = '选择列',
  emptyLabel,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  columns: ColumnMeta[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  if (columns.length === 0) {
    return (
      <Input
        value={value === NONE_VALUE ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="手动输入列名"
      />
    );
  }
  const names = columns.map((c) => c.name);
  const hasFallback = Boolean(value) && !names.includes(value);
  return (
    <Select
      value={value || (emptyLabel ? NONE_VALUE : '')}
      onValueChange={(next) => onChange(next === NONE_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger className={cn('h-8 text-xs', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel && <SelectItem value={NONE_VALUE}>{emptyLabel}</SelectItem>}
        {hasFallback && <SelectItem value={value}>{value}</SelectItem>}
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

