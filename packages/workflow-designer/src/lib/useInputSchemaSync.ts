import { useEffect } from 'react';
import { useWorkflowStore } from '@/store/workflowStore';

/**
 * 监听输入节点配置，防抖后自动探测其数据结构。
 * 保证加载已保存的工作流时无需逐个打开面板即可刷新下游可用列。
 */
export function useInputSchemaSync(delay = 400): void {
  const nodes = useWorkflowStore((s) => s.nodes);
  const workflowId = useWorkflowStore((s) => s.workflowId);

  useEffect(() => {
    const timer = setTimeout(() => {
      void useWorkflowStore.getState().probeAllInputs();
    }, delay);
    return () => clearTimeout(timer);
  }, [nodes, workflowId, delay]);
}
