import type { ComponentType, ReactNode } from 'react';
import { cn } from './utils';

/** 空态：图标 + 标题 + 说明 +（可选）操作 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      {Icon ? (
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-md text-xs text-muted-foreground">{description}</p> : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
