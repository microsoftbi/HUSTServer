import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useWorkflowStore } from '@/store/workflowStore';

const MIN_LIMIT = 1;
const MAX_LIMIT = 10000;

/** 系统配置子窗体：数据预览缓存行数。设置保存在浏览器本地。 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const previewRowLimit = useWorkflowStore((s) => s.settings.previewRowLimit);
  const updateSettings = useWorkflowStore((s) => s.updateSettings);

  const [value, setValue] = useState(String(previewRowLimit));
  const [error, setError] = useState<string | null>(null);

  // 每次打开时以当前配置初始化
  useEffect(() => {
    if (!open) return;
    setValue(String(previewRowLimit));
    setError(null);
  }, [open, previewRowLimit]);

  const parsed = Number(value);
  const invalid = !Number.isInteger(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT;

  const handleSave = () => {
    if (invalid) {
      setError(`请输入 ${MIN_LIMIT} - ${MAX_LIMIT} 之间的整数`);
      return;
    }
    updateSettings({ previewRowLimit: parsed });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>系统配置</DialogTitle>
          <DialogDescription>配置数据预览的行数上限。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="preview-row-limit">预览缓存行数</Label>
          <Input
            id="preview-row-limit"
            type="number"
            min={MIN_LIMIT}
            max={MAX_LIMIT}
            step={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            范围 {MIN_LIMIT} - {MAX_LIMIT}，默认 10000。数据预览最多显示该行数，超出部分以「仅显示前 X / Y 行」提示。
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={handleSave} disabled={invalid}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
