import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileOutput, Inbox, Upload } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Input, Select } from '../components/ui/input.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
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

interface ResourceFile {
  name: string;
  path: string;
  size: number;
}

/** 输入绑定的目标类型与中文标签（与后端 mapping target_type 对齐）。 */
const TARGET_OPTIONS: { value: InputBinding['targetType']; label: string }[] = [
  { value: 'uploaded_file', label: '上传的数据文件' },
  { value: 'server_path', label: '服务端路径' },
  { value: 'connection', label: '连接' },
  { value: 'resource', label: '资源库文件' },
];

export function WorkflowUploadPage() {
  const navigate = useNavigate();
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [name, setName] = useState('');
  const [bindings, setBindings] = useState<Record<string, InputBinding>>({});
  const [dataFiles, setDataFiles] = useState<Record<string, File>>({});
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [resources, setResources] = useState<ResourceFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<ConnectionOption[]>('/api/connections')
      .then(setConnections)
      .catch(() => undefined);
    api
      .get<{ files: ResourceFile[] }>('/api/resources/tree')
      .then((res) => setResources(res.files))
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

  /** 切换目标类型，并带入该类型的默认目标引用（保留原单选逻辑）。 */
  function chooseTarget(input: InputRef, type: InputBinding['targetType']) {
    if (type === 'server_path') {
      setBinding(input.nodeId, { targetType: type, targetRef: input.originalRef });
    } else if (type === 'connection') {
      setBinding(input.nodeId, { targetType: type, targetRef: connections[0]?.id ?? '' });
    } else if (type === 'resource') {
      setBinding(input.nodeId, { targetType: type, targetRef: resources[0]?.path ?? '' });
    } else {
      setBinding(input.nodeId, { targetType: type, targetRef: '' });
    }
  }

  async function submit() {
    if (!parsed) return;
    for (const input of parsed.inputs) {
      const binding = bindings[input.nodeId];
      if (binding?.targetType === 'uploaded_file' && !dataFiles[input.nodeId]) {
        setError(`输入「${input.name}」选择了上传数据文件，但未选择文件。`);
        return;
      }
      if (binding?.targetType === 'resource' && !binding.targetRef) {
        setError(`输入「${input.name}」选择了资源库文件，但未选择具体文件。`);
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
      <div className="space-y-4">
        <PageHeader
          title="上传工作流"
          description="选择 HUSTERYX 导出的 .htyx 工作流文件，并为输入节点绑定数据文件。"
        >
          <Button asChild variant="outline">
            <Link to="/workflows">
              <ArrowLeft />
              返回列表
            </Link>
          </Button>
        </PageHeader>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Upload className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">选择 HUSTERYX 导出的工作流文件</p>
              <p className="text-xs text-muted-foreground">支持 .htyx / .json 格式。</p>
            </div>
            <Input
              type="file"
              accept="application/json,.json,.htyx"
              className="h-auto py-1.5 file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-secondary-foreground"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void parseJson(file);
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="配置输入绑定" description="确认名称与输入绑定后创建工作流。">
        <Button asChild variant="outline">
          <Link to="/workflows">
            <ArrowLeft />
            返回列表
          </Link>
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? '提交中…' : '创建工作流'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>工作流名称</CardTitle>
            <CardDescription>默认取自已导入的文件，可在此调整。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>输入绑定</CardTitle>
            <CardDescription>为每个输入节点选择数据来源。</CardDescription>
          </div>
          <Badge tone="neutral">{parsed.inputs.length} 个输入</Badge>
        </CardHeader>
        {parsed.inputs.length === 0 ? (
          <EmptyState icon={Inbox} title="无输入节点" description="该工作流无需绑定输入数据文件。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>输入组件</TableHead>
                <TableHead>原始路径</TableHead>
                <TableHead className="w-72">目标类型</TableHead>
                <TableHead className="w-80">目标</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parsed.inputs.map((input) => {
                const binding = bindings[input.nodeId];
                return (
                  <TableRow key={input.nodeId}>
                    <TableCell className="font-medium">{input.name}</TableCell>
                    <TableCell className="text-muted-foreground">{input.originalRef}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {TARGET_OPTIONS.map((opt) => (
                          <button key={opt.value} type="button" onClick={() => chooseTarget(input, opt.value)}>
                            <Badge tone={binding?.targetType === opt.value ? 'primary' : 'neutral'}>
                              {opt.label}
                            </Badge>
                          </button>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {binding?.targetType === 'server_path' && (
                        <Input
                          placeholder="/absolute/path/data.csv"
                          value={binding.targetRef}
                          onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                        />
                      )}
                      {binding?.targetType === 'connection' && (
                        <Select
                          value={binding.targetRef}
                          onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                        >
                          <option value="">请选择连接…</option>
                          {connections.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      )}
                      {binding?.targetType === 'resource' && (
                        <Select
                          value={binding.targetRef}
                          onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                        >
                          <option value="">请选择资源库文件…</option>
                          {resources.map((r) => (
                            <option key={r.path} value={r.path}>
                              {r.path}
                            </option>
                          ))}
                        </Select>
                      )}
                      {binding?.targetType === 'uploaded_file' && (
                        <Input
                          type="file"
                          className="h-auto py-1.5 file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-secondary-foreground"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) setDataFiles((prev) => ({ ...prev, [input.nodeId]: file }));
                          }}
                        />
                      )}
                      {!binding && <span className="text-xs text-muted-foreground">-</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>输出</CardTitle>
            <CardDescription>运行结果统一写入服务端输出目录。</CardDescription>
          </div>
          <Badge tone="neutral">{parsed.outputs.length} 个输出</Badge>
        </CardHeader>
        {parsed.outputs.length === 0 ? (
          <EmptyState icon={FileOutput} title="无输出节点" description="该工作流未包含输出节点。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>输出组件</TableHead>
                <TableHead>原始路径</TableHead>
                <TableHead className="w-40">目标类型</TableHead>
                <TableHead>目标</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parsed.outputs.map((output) => (
                <TableRow key={output.nodeId}>
                  <TableCell className="font-medium">{output.name}</TableCell>
                  <TableCell className="text-muted-foreground">{output.originalRef}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">服务端输出目录</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    运行结果写入服务端输出目录（{output.originalRef} 的文件名）
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
