import { Field, Select, Textarea } from '../../../components/ui/input.js';
import type { JobNodeConfig } from '../../../types.js';

export function SqlNodeForm({
  config,
  connections,
  disabled = false,
  onChange,
}: {
  config: JobNodeConfig;
  connections: Array<{ id: string; name: string }>;
  disabled?: boolean;
  onChange: (patch: Partial<JobNodeConfig>) => void;
}) {
  const connectionId = typeof config.connectionId === 'string' ? config.connectionId : '';
  const sql = typeof config.sql === 'string' ? config.sql : '';
  return (
    <>
      <Field label="连接（SQL Server）">
        <Select
          value={connectionId}
          disabled={disabled}
          onChange={(event) => onChange({ connectionId: event.target.value })}
        >
          <option value="">请选择…</option>
          {connections.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="SQL（将直接在该连接上执行）">
        <Textarea
          className="min-h-28 font-mono"
          value={sql}
          disabled={disabled}
          onChange={(event) => onChange({ sql: event.target.value })}
        />
      </Field>
    </>
  );
}
