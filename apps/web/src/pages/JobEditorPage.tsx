import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, History, ListChecks, Pencil, Play, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Checkbox, Field, Input, Select, Textarea } from '../components/ui/input.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { Modal } from '../components/ui/modal.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import type { JobOnFailure, JobRunSummary, JobStepType, LoadModelSource, WorkflowSummary } from '../types.js';

interface ConnectionOption {
  id: string;
  name: string;
  type: string;
}

/** 编辑器内的步骤草稿（key 仅用于 React 列表渲染）。 */
interface EditorStep {
  key: number;
  type: JobStepType;
  name: string;
  workflowId: string;
  connectionId: string;
  sql: string;
  modelName: string;
  source: LoadModelSource;
  resourcePath: string;
  object: string;
  onFailure: JobOnFailure;
}

/** 步骤编辑弹窗状态；editingKey 为 null 表示新增。 */
interface StepModalState {
  editingKey: number | null;
  step: EditorStep;
}

interface ScheduleForm {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron';
  time: string;
  weekday: number;
  monthDay: number;
  cronExpr: string;
  timezone: string;
}

interface JobDetailLike {
  id: string;
  name: string;
  description: string | null;
  steps: Array<{
    type: JobStepType;
    name: string;
    config: {
      workflowId?: string;
      connectionId?: string;
      sql?: string;
      modelName?: string;
      source?: LoadModelSource;
      resourcePath?: string;
      object?: string;
    };
    onFailure: JobOnFailure;
  }>;
  schedule: {
    enabled: boolean;
    freqType: 'daily' | 'weekly' | 'monthly' | 'cron' | null;
    cronExpr: string | null;
    timezone: string;
  };
}

const DEFAULT_SCHEDULE: ScheduleForm = {
  enabled: false,
  freqType: 'daily',
  time: '08:00',
  weekday: 1,
  monthDay: 1,
  cronExpr: '0 8 * * *',
  timezone: 'Asia/Shanghai',
};

const FREQ_OPTIONS: Array<{ value: ScheduleForm['freqType']; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'cron', label: '自定义 cron' },
];

/** 步骤类型显示名（用于步骤表格与徽标）。 */
const STEP_TYPE_LABEL: Record<JobStepType, string> = {
  workflow: '工作流',
  sql: 'SQL',
  load_model: '模型',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  failed: '失败',
  canceled: '已取消',
  skipped: '已跳过',
};

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  queued: 'neutral',
  running: 'primary',
  success: 'success',
  error: 'danger',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'neutral',
};

let stepKeySeed = 0;
function nextStepKey(): number {
  stepKeySeed += 1;
  return stepKeySeed;
}

function defaultStepName(type: JobStepType): string {
  if (type === 'workflow') return '运行工作流';
  if (type === 'sql') return '运行 SQL';
  return '加载成模型';
}

/** 自动生成的默认名称集合；名称仍为其中之一时，切换类型会同步更新。 */
const DEFAULT_STEP_NAMES: readonly string[] = [
  defaultStepName('sql'),
  defaultStepName('workflow'),
  defaultStepName('load_model'),
];

function newStep(type: JobStepType): EditorStep {
  return {
    key: nextStepKey(),
    type,
    name: defaultStepName(type),
    workflowId: '',
    connectionId: '',
    sql: '',
    modelName: '',
    source: 'file',
    resourcePath: '',
    object: '',
    onFailure: 'abort',
  };
}

/** 把 DB 里的调度字段反解回表单；解析不出预设时回退为 cron 模式。 */
function cronToForm(freqType: string | null, cronExpr: string | null, timezone: string, enabled: boolean): ScheduleForm {
  const base: ScheduleForm = { ...DEFAULT_SCHEDULE, timezone, enabled };
  if (!freqType || !cronExpr) return base;
  if (freqType === 'cron') return { ...base, freqType: 'cron', cronExpr };
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, freqType: 'cron', cronExpr };
  const [min, hour] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (freqType === 'daily') return { ...base, freqType: 'daily', time };
  if (freqType === 'weekly') {
    const dow = Number(parts[4]);
    return { ...base, freqType: 'weekly', time, weekday: Number.isInteger(dow) ? dow : 1 };
  }
  const dom = Number(parts[2]);
  return { ...base, freqType: 'monthly', time, monthDay: Number.isInteger(dom) ? dom : 1 };
}

export function JobEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<EditorStep[]>([]);
  const [modal, setModal] = useState<StepModalState | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleForm>(DEFAULT_SCHEDULE);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [resourceFiles, setResourceFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [tables, setTables] = useState<Array<{ schema: string; name: string }>>([]);
  const [history, setHistory] = useState<JobRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.get<WorkflowSummary[]>('/api/workflows').then(setWorkflows).catch(() => {});
    void api
      .get<ConnectionOption[]>('/api/connections')
      .then((list) => setConnections(list.filter((c) => c.type === 'sqlserver')))
      .catch(() => {});
    void api
      .get<{ files: Array<{ name: string; path: string }> }>('/api/resources/tree')
      .then((tree) => setResourceFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) return;
    void (async () => {
      try {
        const job = await api.get<JobDetailLike>(`/api/jobs/${id}`);
        setName(job.name);
        setDescription(job.description ?? '');
        setSteps(job.steps.map((s) => ({
          key: nextStepKey(),
          type: s.type,
          name: s.name,
          workflowId: s.config.workflowId ?? '',
          connectionId: s.config.connectionId ?? '',
          sql: s.config.sql ?? '',
          modelName: s.config.modelName ?? '',
          source: s.config.source ?? 'file',
          resourcePath: s.config.resourcePath ?? '',
          object: s.config.object ?? '',
          onFailure: s.onFailure,
        })));
        setSchedule(cronToForm(job.schedule.freqType, job.schedule.cronExpr, job.schedule.timezone, job.schedule.enabled));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [id, isNew]);

  useEffect(() => {
    if (isNew) return;
    void api
      .get<{ items: JobRunSummary[] }>(`/api/jobs/${id}/runs?limit=10`)
      .then((res) => setHistory(res.items))
      .catch(() => {});
  }, [id, isNew]);

  const draftSource = modal?.step.type === 'load_model' ? modal.step.source : null;
  const draftConnId = modal?.step.type === 'load_model' ? modal.step.connectionId : '';
  useEffect(() => {
    if (draftSource !== 'sqlserver' || !draftConnId) {
      setTables([]);
      return;
    }
    let cancelled = false;
    void api
      .post<{ tables: Array<{ schema: string; name: string }> }>('/api/data/tables', {
        body: { connectionId: draftConnId },
      })
      .then((res) => {
        if (!cancelled) setTables(res.tables.map((t) => ({ schema: t.schema, name: t.name })));
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draftSource, draftConnId]);

  const openAdd = (): void => {
    setModalError(null);
    setModal({ editingKey: null, step: newStep('sql') });
  };

  const openEdit = (step: EditorStep): void => {
    setModalError(null);
    setModal({ editingKey: step.key, step: { ...step } });
  };

  const closeModal = (): void => {
    setModal(null);
    setModalError(null);
  };

  const patchDraft = (patch: Partial<EditorStep>): void => {
    setModal((prev) => (prev ? { ...prev, step: { ...prev.step, ...patch } } : prev));
  };

  const switchDraftType = (type: JobStepType): void => {
    setModal((prev) => {
      if (!prev) return prev;
      const { step } = prev;
      const shouldRename = DEFAULT_STEP_NAMES.includes(step.name.trim());
      return { ...prev, step: { ...step, type, name: shouldRename ? defaultStepName(type) : step.name } };
    });
  };

  const confirmDraft = (): void => {
    if (!modal) return;
    const draft = modal.step;
    if (draft.type === 'workflow') {
      if (!draft.workflowId) return setModalError('请选择工作流');
    } else if (draft.type === 'sql') {
      if (!draft.connectionId) return setModalError('请选择连接');
      if (!draft.sql.trim()) return setModalError('请填写 SQL');
    } else {
      if (!draft.modelName.trim()) return setModalError('请填写模型名');
      if (draft.source === 'file') {
        if (!draft.resourcePath) return setModalError('请选择资源文件');
      } else {
        if (!draft.connectionId) return setModalError('请选择连接');
        if (!draft.object) return setModalError('请选择数据表');
      }
    }
    const next: EditorStep = { ...draft, name: draft.name.trim() || defaultStepName(draft.type) };
    setSteps((prev) =>
      modal.editingKey == null ? [...prev, next] : prev.map((s) => (s.key === modal.editingKey ? next : s)),
    );
    closeModal();
  };

  useEffect(() => {
    if (!modal) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setModal(null);
        setModalError(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modal]);

  const moveStep = (index: number, dir: -1 | 1): void => {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  function validate(): string | null {
    if (!name.trim()) return '请填写 Job 名称';
    if (steps.length === 0) return '至少需要一个步骤';
    for (const [i, s] of steps.entries()) {
      if (s.type === 'workflow' && !s.workflowId) return `步骤 ${i + 1}：请选择工作流`;
      if (s.type === 'sql') {
        if (!s.connectionId) return `步骤 ${i + 1}：请选择连接`;
        if (!s.sql.trim()) return `步骤 ${i + 1}：请填写 SQL`;
      }
      if (s.type === 'load_model') {
        if (!s.modelName.trim()) return `步骤 ${i + 1}：请填写模型名`;
        if (s.source === 'file') {
          if (!s.resourcePath) return `步骤 ${i + 1}：请选择资源文件`;
        } else {
          if (!s.connectionId) return `步骤 ${i + 1}：请选择连接`;
          if (!s.object) return `步骤 ${i + 1}：请选择数据表`;
        }
      }
    }
    if (schedule.enabled && schedule.freqType === 'cron' && !schedule.cronExpr.trim()) return '请填写 cron 表达式';
    return null;
  }

  async function save(): Promise<void> {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        steps: steps.map((s) => {
          if (s.type === 'workflow') {
            return { type: s.type, name: s.name, workflowId: s.workflowId, onFailure: s.onFailure };
          }
          if (s.type === 'sql') {
            return { type: s.type, name: s.name, connectionId: s.connectionId, sql: s.sql, onFailure: s.onFailure };
          }
          return s.source === 'file'
            ? {
                type: s.type, name: s.name, onFailure: s.onFailure,
                source: 'file', modelName: s.modelName, resourcePath: s.resourcePath,
              }
            : {
                type: s.type, name: s.name, onFailure: s.onFailure,
                source: 'sqlserver', modelName: s.modelName, connectionId: s.connectionId, object: s.object,
              };
        }),
        schedule: schedule.enabled
          ? {
              enabled: true,
              freqType: schedule.freqType,
              time: schedule.time,
              weekday: schedule.weekday,
              monthDay: schedule.monthDay,
              cronExpr: schedule.cronExpr,
              timezone: schedule.timezone,
            }
          : { enabled: false },
      };
      if (isNew) {
        const created = await api.post<{ id: string }>('/api/jobs', { body });
        window.alert('保存成功');
        navigate(`/jobs/${created.id}`, { replace: true });
      } else {
        await api.put(`/api/jobs/${id}`, { body });
        setError(null);
        window.alert('保存成功');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow(): Promise<void> {
    if (!id) return;
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${id}/runs`);
      navigate(`/job-runs/${res.jobRunId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={isNew ? '新建 Job' : name ? `编辑「${name}」` : '编辑 Job'}
        description="把工作流、SQL 与加载模型串成有序流水线，可手动运行或定时调度。"
      >
        <Button asChild variant="outline">
          <Link to="/jobs">
            <ArrowLeft />
            返回列表
          </Link>
        </Button>
        {!isNew && (
          <Button variant="outline" onClick={() => void runNow()}>
            <Play />
            手动运行
          </Button>
        )}
        <Button disabled={saving} onClick={() => void save()}>
          <Save />
          {saving ? '保存中…' : '保存'}
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="名称（必填）">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="描述">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>步骤编排</CardTitle>
            <CardDescription>按顺序执行，可通过上移 / 下移调整优先级。</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={openAdd}>
            <Plus />
            添加步骤
          </Button>
        </CardHeader>
        {steps.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="暂无步骤"
            description="点击右上角「添加步骤」开始编排流水线。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14">序号</TableHead>
                <TableHead className="w-24">类型</TableHead>
                <TableHead>步骤</TableHead>
                <TableHead className="w-24">失败策略</TableHead>
                <TableHead className="w-40 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s, i) => {
                const workflowName = workflows.find((w) => w.id === s.workflowId)?.name ?? '（未选择）';
                const connectionName = connections.find((c) => c.id === s.connectionId)?.name ?? '（未选择）';
                const sqlLine = s.sql.trim() ? s.sql.trim().split('\n')[0].slice(0, 60) : '（空）';
                return (
                  <TableRow key={s.key}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <Badge tone="neutral">{STEP_TYPE_LABEL[s.type]}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{s.name}</div>
                      <p className="text-xs text-muted-foreground">
                        {s.type === 'workflow'
                          ? `工作流：${workflowName}`
                          : s.type === 'sql'
                            ? `连接：${connectionName} · SQL：${sqlLine}`
                            : `模型：${s.modelName || '（未命名）'} · 来源：${
                                s.source === 'file'
                                  ? s.resourcePath || '（未选择）'
                                  : s.object || '（未选择）'
                              }`}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.onFailure === 'abort' ? '中止' : '继续'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="上移"
                          disabled={i === 0}
                          onClick={() => moveStep(i, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="下移"
                          disabled={i === steps.length - 1}
                          onClick={() => moveStep(i, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button variant="ghost" size="sm" aria-label="编辑" onClick={() => openEdit(s)}>
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="删除"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setSteps((prev) => prev.filter((x) => x.key !== s.key))}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>调度配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={schedule.enabled}
              onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })}
            />
            启用定时调度
          </label>
          {schedule.enabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="频次">
                <Select
                  value={schedule.freqType}
                  onChange={(e) => setSchedule({ ...schedule, freqType: e.target.value as ScheduleForm['freqType'] })}
                >
                  {FREQ_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </Field>
              {schedule.freqType !== 'cron' && (
                <Field label="时间">
                  <Input
                    type="time"
                    value={schedule.time}
                    onChange={(e) => setSchedule({ ...schedule, time: e.target.value })}
                  />
                </Field>
              )}
              {schedule.freqType === 'weekly' && (
                <Field label="星期">
                  <Select
                    value={schedule.weekday}
                    onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}
                  >
                    {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, idx) => (
                      <option key={idx} value={idx}>{label}</option>
                    ))}
                  </Select>
                </Field>
              )}
              {schedule.freqType === 'monthly' && (
                <Field label="日期（1-31）">
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={schedule.monthDay}
                    onChange={(e) => setSchedule({ ...schedule, monthDay: Number(e.target.value) })}
                  />
                </Field>
              )}
              {schedule.freqType === 'cron' && (
                <Field label="cron 表达式（5 段）">
                  <Input
                    className="font-mono"
                    value={schedule.cronExpr}
                    onChange={(e) => setSchedule({ ...schedule, cronExpr: e.target.value })}
                  />
                </Field>
              )}
              <Field label="时区">
                <Input value={schedule.timezone} onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })} />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>

      {!isNew && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>最近运行（10 条）</CardTitle>
          </CardHeader>
          {history.length === 0 ? (
            <EmptyState icon={History} title="暂无运行记录" description="保存后可手动运行，或等待定时调度触发。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-32">状态</TableHead>
                  <TableHead className="w-28">触发方式</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead className="w-28 text-right">耗时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link to={`/job-runs/${r.id}`}>
                        <Badge dot tone={STATUS_TONE[r.status] ?? 'neutral'}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </Badge>
                      </Link>
                    </TableCell>
                    <TableCell>{r.trigger_type === 'manual' ? '手动' : '调度'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.started_at ? new Date(r.started_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {r.duration_ms != null ? `${r.duration_ms} ms` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}

      {modal && (
        <Modal
          open
          onClose={closeModal}
          title={modal.editingKey == null ? '添加步骤' : '编辑步骤'}
          className="max-w-lg"
          footer={
            <>
              <Button variant="outline" onClick={closeModal}>取消</Button>
              <Button onClick={confirmDraft}>{modal.editingKey == null ? '添加' : '保存'}</Button>
            </>
          }
        >
          <div className="flex gap-1 rounded-md bg-muted p-1">
            <Button
              type="button"
              size="sm"
              variant={modal.step.type === 'workflow' ? 'secondary' : 'ghost'}
              className="flex-1"
              onClick={() => switchDraftType('workflow')}
            >
              运行工作流
            </Button>
            <Button
              type="button"
              size="sm"
              variant={modal.step.type === 'sql' ? 'secondary' : 'ghost'}
              className="flex-1"
              onClick={() => switchDraftType('sql')}
            >
              运行 SQL
            </Button>
            <Button
              type="button"
              size="sm"
              variant={modal.step.type === 'load_model' ? 'secondary' : 'ghost'}
              className="flex-1"
              onClick={() => switchDraftType('load_model')}
            >
              加载成模型
            </Button>
          </div>
          {modalError && <ErrorNote>{modalError}</ErrorNote>}
          <Field label="步骤名称">
            <Input value={modal.step.name} onChange={(e) => patchDraft({ name: e.target.value })} />
          </Field>
          {modal.step.type === 'load_model' ? (
            <>
              <Field label="数据来源">
                <Select
                  value={modal.step.source}
                  onChange={(e) => patchDraft({ source: e.target.value as LoadModelSource })}
                >
                  <option value="file">资源库文件（CSV/Excel）</option>
                  <option value="sqlserver">SQL Server 表</option>
                </Select>
              </Field>
              {modal.step.source === 'file' ? (
                <Field label="资源文件">
                  <Select
                    value={modal.step.resourcePath}
                    onChange={(e) => patchDraft({ resourcePath: e.target.value })}
                  >
                    <option value="">请选择…</option>
                    {resourceFiles.map((f) => (
                      <option key={f.path} value={f.path}>{f.name}</option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <>
                  <Field label="连接（SQL Server）">
                    <Select
                      value={modal.step.connectionId}
                      onChange={(e) => patchDraft({ connectionId: e.target.value, object: '' })}
                    >
                      <option value="">请选择…</option>
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="数据表">
                    <Select
                      value={modal.step.object}
                      onChange={(e) => patchDraft({ object: e.target.value })}
                    >
                      <option value="">请选择…</option>
                      {tables.map((t) => (
                        <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>
                          {t.schema}.{t.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
              <Field label="模型名（字母或下划线开头，仅含字母数字下划线，最长 64）">
                <Input
                  className="font-mono"
                  value={modal.step.modelName}
                  onChange={(e) => patchDraft({ modelName: e.target.value })}
                />
              </Field>
            </>
          ) : modal.step.type === 'workflow' ? (
            <Field label="工作流">
              <Select value={modal.step.workflowId} onChange={(e) => patchDraft({ workflowId: e.target.value })}>
                <option value="">请选择…</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              <Field label="连接（SQL Server）">
                <Select
                  value={modal.step.connectionId}
                  onChange={(e) => patchDraft({ connectionId: e.target.value })}
                >
                  <option value="">请选择…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="SQL（将直接在该连接上执行）">
                <Textarea
                  className="min-h-28 font-mono"
                  value={modal.step.sql}
                  onChange={(e) => patchDraft({ sql: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="失败策略">
            <Select
              value={modal.step.onFailure}
              onChange={(e) => patchDraft({ onFailure: e.target.value as JobOnFailure })}
            >
              <option value="abort">中止（后续步骤跳过）</option>
              <option value="continue">继续（记录失败并执行下一步）</option>
            </Select>
          </Field>
        </Modal>
      )}
    </div>
  );
}
