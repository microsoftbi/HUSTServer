import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../../api.js';
import { Button } from '../ui/button.js';
import { ErrorNote } from '../ui/error-note.js';
import { Field, Input, Select } from '../ui/input.js';
import { Modal } from '../ui/modal.js';

interface ConnectionOption {
  id: string;
  name: string;
  type: string;
}

interface ResourceFile {
  name: string;
  path: string;
}

interface TableOption {
  schema: string;
  name: string;
}

/** 与后端 MODEL_NAME_RE 一致的模型名规则 */
const MODEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 资源库里可作为模型来源的文件类型（与 Job 编辑器的「加载成模型」一致） */
const RESOURCE_FILE_RE = /\.(csv|xlsx|xls)$/i;

export interface CreatedModel {
  name: string;
  rowCount: number;
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

/** 新建数据模型：直接调用与 Job「加载成模型」步骤相同的载入逻辑。 */
export function CreateModelModal({
  open,
  existingNames,
  onClose,
  onCreated,
}: {
  open: boolean;
  existingNames: string[];
  onClose: () => void;
  onCreated: (created: CreatedModel) => void;
}) {
  const [modelName, setModelName] = useState('');
  const [source, setSource] = useState<'file' | 'sqlserver'>('file');
  const [resourcePath, setResourcePath] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [object, setObject] = useState('');
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [tables, setTables] = useState<TableOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开重置表单并拉取来源选项
  useEffect(() => {
    if (!open) return;
    setModelName('');
    setSource('file');
    setResourcePath('');
    setConnectionId('');
    setObject('');
    setTables([]);
    setSaving(false);
    setError(null);
    void api
      .get<{ files: ResourceFile[] }>('/api/resources/tree')
      .then((tree) => setFiles(tree.files.filter((f) => RESOURCE_FILE_RE.test(f.name))))
      .catch(() => setFiles([]));
    void api
      .get<ConnectionOption[]>('/api/connections')
      .then((list) => setConnections(list.filter((c) => c.type === 'sqlserver')))
      .catch(() => setConnections([]));
  }, [open]);

  // 选定连接后取表清单
  useEffect(() => {
    setObject('');
    if (!open || source !== 'sqlserver' || !connectionId) {
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
  }, [open, source, connectionId]);

  async function submit(): Promise<void> {
    const name = modelName.trim();
    if (!name) return setError('请填写模型名');
    if (!MODEL_NAME_RE.test(name)) {
      return setError('模型名不合法：字母或下划线开头，仅含字母数字下划线，最长 64 位');
    }
    if (source === 'file' && !resourcePath) return setError('请选择资源文件');
    if (source === 'sqlserver' && !connectionId) return setError('请选择连接');
    if (source === 'sqlserver' && !object) return setError('请选择数据表');
    if (existingNames.includes(name)) {
      const ok = window.confirm(
        `已存在同名模型「${name}」，继续将覆盖它（任一步失败旧模型保持不变）。`,
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<CreatedModel>('/api/models', {
        body:
          source === 'file'
            ? { modelName: name, source, resourcePath }
            : { modelName: name, source, connectionId, object },
      });
      onCreated(created);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? () => undefined : onClose}
      title="新建数据模型"
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? '载入中…' : '载入'}
          </Button>
        </>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      <Field label="模型名" hint="字母或下划线开头，仅含字母数字下划线，最长 64 位">
        <Input
          autoFocus
          className="font-mono"
          placeholder="例如 sales_2026"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
        />
      </Field>

      <Field label="数据来源">
        <Select value={source} onChange={(e) => setSource(e.target.value as 'file' | 'sqlserver')}>
          <option value="file">资源库文件（CSV / Excel）</option>
          <option value="sqlserver">SQL Server 表</option>
        </Select>
      </Field>

      {source === 'file' ? (
        <Field label="资源文件">
          <Select value={resourcePath} onChange={(e) => setResourcePath(e.target.value)}>
            <option value="">
              {files.length === 0 ? '资源库暂无可用的 CSV / Excel 文件' : '请选择文件'}
            </option>
            {files.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field label="连接">
            <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">
                {connections.length === 0 ? '暂无 SQL Server 连接' : '请选择连接'}
              </option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="数据表">
            <Select
              value={object}
              disabled={!connectionId || tables.length === 0}
              onChange={(e) => setObject(e.target.value)}
            >
              <option value="">
                {!connectionId ? '请先选择连接' : tables.length === 0 ? '该连接下暂无数据表' : '请选择数据表'}
              </option>
              {tables.map((t) => (
                <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>
                  {t.schema}.{t.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        载入在服务端同步执行，数据量大时耗时较久，弹窗会一直显示「载入中…」。同名模型将被覆盖，失败时旧模型保持不变。
      </p>
    </Modal>
  );
}
