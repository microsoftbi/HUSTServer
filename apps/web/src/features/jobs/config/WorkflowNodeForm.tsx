import { Field, Select } from '../../../components/ui/input.js';
import type { JobNodeConfig, WorkflowSummary } from '../../../types.js';

export function WorkflowNodeForm({
  config,
  workflows,
  disabled = false,
  onChange,
}: {
  config: JobNodeConfig;
  workflows: WorkflowSummary[];
  disabled?: boolean;
  onChange: (patch: Partial<JobNodeConfig>) => void;
}) {
  const workflowId = typeof config.workflowId === 'string' ? config.workflowId : '';
  return (
    <Field label="工作流">
      <Select
        value={workflowId}
        disabled={disabled}
        onChange={(event) => onChange({ workflowId: event.target.value })}
      >
        <option value="">请选择…</option>
        {workflows.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </Select>
    </Field>
  );
}
