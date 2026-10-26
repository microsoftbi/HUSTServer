import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import { Field, Input, Select } from '../../../components/ui/input.js';
import type { JobNodeConfig, LoadModelSource } from '../../../types.js';

interface TableOption {
  schema: string;
  name: string;
}

export function LoadModelNodeForm({
  config,
  connections,
  resourceFiles,
  disabled = false,
  onChange,
}: {
  config: JobNodeConfig;
  connections: Array<{ id: string; name: string }>;
  resourceFiles: Array<{ name: string; path: string }>;
  disabled?: boolean;
  onChange: (patch: Partial<JobNodeConfig>) => void;
}) {
  const source: LoadModelSource = config.source === 'sqlserver' ? 'sqlserver' : 'file';
  const connectionId = typeof config.connectionId === 'string' ? config.connectionId : '';
  const resourcePath = typeof config.resourcePath === 'string' ? config.resourcePath : '';
  const object = typeof config.object === 'string' ? config.object : '';
  const modelName = typeof config.modelName === 'string' ? config.modelName : '';

  const [tables, setTables] = useState<TableOption[]>([]);

  useEffect(() => {
    if (source !== 'sqlserver' || !connectionId) {
      setTables([]);
      return;
    }
    let cancelled = false;
    void api
      .post<{ tables: TableOption[] }>('/api/data/tables', { body: { connectionId } })
      .then((res) => {
        if (!cancelled) setTables(res.tables.map((t) => ({ schema: t.schema, name: t.name })));
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [source, connectionId]);

  return (
    <>
      <Field label="数据来源">
        <Select
          value={source}
          disabled={disabled}
          onChange={(event) => onChange({ source: event.target.value as LoadModelSource })}
        >
          <option value="file">资源库文件（CSV/Excel）</option>
          <option value="sqlserver">SQL Server 表</option>
        </Select>
      </Field>
      {source === 'file' ? (
        <Field label="资源文件">
          <Select
            value={resourcePath}
            disabled={disabled}
            onChange={(event) => onChange({ resourcePath: event.target.value })}
          >
            <option value="">请选择…</option>
            {resourceFiles.map((file) => (
              <option key={file.path} value={file.path}>{file.name}</option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field label="连接（SQL Server）">
            <Select
              value={connectionId}
              disabled={disabled}
              onChange={(event) => onChange({ connectionId: event.target.value, object: '' })}
            >
              <option value="">请选择…</option>
              {connections.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="数据表">
            <Select
              value={object}
              disabled={disabled || !connectionId}
              onChange={(event) => onChange({ object: event.target.value })}
            >
              <option value="">请选择…</option>
              {tables.map((table) => {
                const value = `${table.schema}.${table.name}`;
                return <option key={value} value={value}>{value}</option>;
              })}
            </Select>
          </Field>
        </>
      )}
      <Field label="模型名（字母或下划线开头，仅含字母数字下划线，最长 64）">
        <Input
          className="font-mono"
          value={modelName}
          disabled={disabled}
          onChange={(event) => onChange({ modelName: event.target.value })}
        />
      </Field>
    </>
  );
}
