import { createContext, useContext, type ReactNode } from 'react';
import type { DesignerAdapter } from './adapters';

export interface DesignerHost {
  adapter: DesignerAdapter;
  onExit?: () => void;
}

const DesignerHostContext = createContext<DesignerHost | null>(null);

export function DesignerHostProvider({ value, children }: { value: DesignerHost; children: ReactNode }) {
  return <DesignerHostContext.Provider value={value}>{children}</DesignerHostContext.Provider>;
}

export function useDesignerHost(): DesignerHost {
  const ctx = useContext(DesignerHostContext);
  if (!ctx) throw new Error('useDesignerHost 必须在 WorkflowDesigner 内使用');
  return ctx;
}
