import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDesignerHost } from '@/context';
import { Field } from '@/components/panels/fields';
import type { SqlConnectionRef } from '@/types';

interface Props {
  /** 所选连接的 id；空字符串表示未选择。 */
  value: string;
  onChange: (connectionId: string) => void;
  /** 节点仍带有旧版内嵌连接信息时为 true，用于提示迁移。 */
  legacyEmbedded?: boolean;
}

/**
 * 连接选择器：从「连接」模块拉取已创建的 SQL Server 连接。
 * 节点只保存 connectionId，密码等凭据留在服务端，不写入工作流。
 */
export function SqlConnectionPicker({ value, onChange, legacyEmbedded }: Props) {
  const { adapter } = useDesignerHost();
  const [connections, setConnections] = useState<SqlConnectionRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = Boolean(adapter.listSqlConnections);

  const load = useCallback(async () => {
    if (!adapter.listSqlConnections) {
      setConnections([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setConnections(await adapter.listSqlConnections());
    } catch (err) {
      setConnections([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [adapter]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasFallback = Boolean(value) && !connections.some((c) => c.id === value);

  return (
    <Field
      label="数据连接"
      hint="引用「连接」模块中已创建的 SQL Server 连接；凭据保存在服务端，不写入工作流。"
    >
      <div className="flex items-center gap-1.5">
        {supported ? (
          <Select value={value || ''} onValueChange={onChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={loading ? '加载中…' : '选择连接'} />
            </SelectTrigger>
            <SelectContent>
              {hasFallback && <SelectItem value={value}>已失效连接（{value}）</SelectItem>}
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name}
                  {conn.server ? ` · ${conn.server}` : ''}
                  {conn.database ? ` / ${conn.database}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input disabled placeholder="当前宿主不支持连接列表" className="h-8 text-xs" />
        )}
        {supported && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title="刷新连接列表"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        )}
      </div>

      {supported && !loading && !error && connections.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          暂无可用连接，请先到「连接」页面创建。
        </p>
      )}

      {legacyEmbedded && (
        <p className="flex items-start gap-1 text-[11px] text-amber-600">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            该节点使用旧版内嵌连接配置。选择上方连接后即改为引用连接，密码不再写入工作流。
          </span>
        </p>
      )}

      {error && (
        <p className="text-[11px] text-destructive" title={error}>
          {error}
        </p>
      )}
    </Field>
  );
}
