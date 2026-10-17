import type { ReactNode } from 'react';
import { cn } from './utils';

/** 行内错误提示条 */
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive', className)}>
      {children}
    </p>
  );
}
