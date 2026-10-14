import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { InputRef, OutputRef } from '../types.js';
import { buildMappingInputs, type InputBinding } from '../workflowMappings.js';

interface ParsedUpload {
  name: string;
  workflow: unknown;
  inputs: InputRef[];
  outputs: OutputRef[];
}

interface ConnectionOption {
  id: string;
  name: string;
}

export function WorkflowUploadPage() {
  const navigate = useNavigate();
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [name, setName] = useState('');
  const [bindings, setBindings] = useState<Record<string, InputBinding>>({});
  const [dataFiles, setDataFiles] = useState<Record<string, File>>({});
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<ConnectionOption[]>('/api/connections')
      .then(setConnections)
      .catch(() => undefined);
  }, []);

  async function parseJson(file: File) {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await api.post<ParsedUpload>('/api/workflows/upload', { form });
      setParsed(res);
      setName(res.name);
      const initial: Record<string, InputBinding> = {};
      for (const input of res.inputs) {
        initial[input.nodeId] =
          input.binding === 'connection'
            ? { targetType: 'connection', targetRef: connections[0]?.id ?? '' }
            : { targetType: 'server_path', targetRef: input.originalRef };
      }
      setBindings(initial);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function setBinding(nodeId: string, patch: Partial<InputBinding>) {
    setBindings((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }));
  }

  async function submit() {
    if (!parsed) return;
    for (const input of parsed.inputs) {
      const binding = bindings[input.nodeId];
      if (binding?.targetType === 'uploaded_file' && !dataFiles[input.nodeId]) {
        setError(`输入「${input.name}」选择了上传数据文件，但未选择文件。`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const nonFileInputs = parsed.inputs.filter((i) => bindings[i.nodeId]?.targetType !== 'uploaded_file');
      const created = await api.post<{ id: string; name: string }>('/api/workflows', {
        body: {
          name: name.trim() || parsed.name,
          workflow: parsed.workflow,
          mappings: buildMappingInputs(nonFileInputs, parsed.outputs, bindings),
        },
      });
      for (const input of parsed.inputs) {
        const file = dataFiles[input.nodeId];
        if (bindings[input.nodeId]?.targetType !== 'uploaded_file' || !file) continue;
        const form = new FormData();
        form.append('nodeId', input.nodeId);
        form.append('file', file);
        await api.post(`/api/workflows/${created.id}/files`, { form });
      }
      navigate(`/workflows/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!parsed) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">上传工作流</h1>
        <p className="text-sm text-slate-600">选择 HUSTERYX 导出的工作流 JSON 文件（.json）。</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void parseJson(file);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">配置输入绑定</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <label className="block space-y-1">
        <span className="text-sm text-slate-600">工作流名称</span>
        <input className="w-full border px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <section className="space-y-2">
        <h2 className="font-medium">输入</h2>
        {parsed.inputs.length === 0 && <p className="text-sm text-slate-500">该工作流无输入节点。</p>}
        {parsed.inputs.map((input) => {
          const binding = bindings[input.nodeId];
          return (
            <div key={input.nodeId} className="space-y-2 rounded border p-3">
              <div className="text-sm">
                <span className="font-medium">{input.name}</span>
                <span className="ml-2 text-slate-500">{input.originalRef}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={binding?.targetType === 'uploaded_file'}
                    onChange={() => setBinding(input.nodeId, { targetType: 'uploaded_file', targetRef: '' })}
                  />
                  上传数据文件
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={binding?.targetType === 'server_path'}
                    onChange={() => setBinding(input.nodeId, { targetType: 'server_path', targetRef: input.originalRef })}
                  />
                  服务端路径
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={binding?.targetType === 'connection'}
                    onChange={() => setBinding(input.nodeId, { targetType: 'connection', targetRef: connections[0]?.id ?? '' })}
                  />
                  连接
                </label>
              </div>

              {binding?.targetType === 'server_path' && (
                <input
                  className="w-full border px-2 py-1 text-sm"
                  placeholder="/absolute/path/data.csv"
                  value={binding.targetRef}
                  onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                />
              )}

              {binding?.targetType === 'connection' && (
                <select
                  className="w-full border px-2 py-1 text-sm"
                  value={binding.targetRef}
                  onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                >
                  <option value="">请选择连接…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}

              {binding?.targetType === 'uploaded_file' && (
                <input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setDataFiles((prev) => ({ ...prev, [input.nodeId]: file }));
                  }}
                />
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-1">
        <h2 className="font-medium">输出</h2>
        {parsed.outputs.length === 0 && <p className="text-sm text-slate-500">该工作流无输出节点。</p>}
        {parsed.outputs.map((output) => (
          <p key={output.nodeId} className="text-sm text-slate-600">
            {output.name} → 运行结果写入服务端输出目录（{output.originalRef} 的文件名）
          </p>
        ))}
      </section>

      <button
        className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? '提交中…' : '创建工作流'}
      </button>
    </div>
  );
}
