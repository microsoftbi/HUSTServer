import { useRef, useState, type ChangeEvent } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDesignerHost } from '@/context';
import { shortenPath } from '@/lib/format';
import type { FileUploadResult } from '@/types';

interface Props {
  value: string;
  onChange: (path: string) => void;
  accept?: string;
  placeholder?: string;
  /** 上传成功后回调，便于 Excel 面板读取工作表列表。 */
  onUploaded?: (result: FileUploadResult) => void;
}

/**
 * 文件路径输入 + 上传按钮。
 * 上传后的文件保存到后端 UPLOAD_DIR，返回其绝对路径写回配置。
 */
export function FilePathField({ value, onChange, accept, placeholder, onUploaded }: Props) {
  const { adapter } = useDesignerHost();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      if (!adapter.uploadFile) return;
      const uploaded = await adapter.uploadFile(file);
      onChange(uploaded.path);
      onUploaded?.(uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? '选择或输入文件路径'}
          title={value}
          className="h-8 text-xs"
        />
        {adapter.uploadFile && (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title="上传文件"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              className="hidden"
              onChange={handleFile}
            />
          </>
        )}
      </div>
      {value && (
        <p className="truncate text-[10px] text-muted-foreground" title={value}>
          {shortenPath(value)}
        </p>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}
