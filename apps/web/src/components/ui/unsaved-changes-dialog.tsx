import { Modal } from './modal';
import { Button } from './button';

/**
 * 未保存更改离开确认：保存并离开 / 不保存离开 / 取消。
 * 供仪表板编辑器、Job 编排等设计界面复用。
 */
export function UnsavedChangesDialog({
  open,
  saving = false,
  onCancel,
  onDiscard,
  onSave,
  description = '当前更改尚未保存，离开后将丢失。是否保存？',
}: {
  open: boolean;
  saving?: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  description?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onCancel();
      }}
      title="未保存的更改"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button variant="outline" onClick={onDiscard} disabled={saving}>
            不保存离开
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? '保存中…' : '保存并离开'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{description}</p>
    </Modal>
  );
}
