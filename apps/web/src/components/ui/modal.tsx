import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from './utils';

/** 轻量弹窗：遮罩点击 / Esc 关闭，内容区点击不冒泡 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={cn(
          'w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-lg',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border/70 px-4 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
