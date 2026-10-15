import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const VERSION = '0.1.0';

/** 「关于」子窗体：展示系统名称、版本与说明。 */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>关于</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            HX
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold">HUSTERYX</div>
            <div className="text-xs text-muted-foreground">低代码 ETL 工具 · 版本 {VERSION}</div>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          这个应用是模仿 Alteryx，使用 Vibe Coding 生成的，仅供学习使用。
        </p>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
