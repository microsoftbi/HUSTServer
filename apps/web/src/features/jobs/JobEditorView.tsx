import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { Toaster, toast } from 'sonner';
import { api } from '../../api.js';
import { UnsavedChangesDialog } from '../../components/ui/unsaved-changes-dialog.js';
import type {
  JobDetail, JobRunSummary, JobStepRunSummary, JobStepType, WorkflowSummary,
} from '../../types.js';
import { JobSettingsDialog } from './JobSettingsDialog.js';
import { JobRunOutputPanel } from './JobRunOutputPanel.js';
import { JobCanvas } from './canvas/JobCanvas.js';
import { JobInspector } from './canvas/JobInspector.js';
import { JobPalette } from './canvas/JobPalette.js';
import { JobToolbar } from './canvas/JobToolbar.js';
import type { JobNodeStatus } from './canvas/JobNodeCard.js';
import { DEFAULT_SCHEDULE, fromDetail, type JobDraft } from './lib/api.js';
import { nodeIssues, type NodeLookups } from './lib/nodeMeta.js';
import { useJobEditorStore } from './store/jobEditorStore.js';
import { useCanvasTheme } from '../theme/themeStore.js';

const EMPTY_DRAFT: JobDraft = {
  name: '',
  description: '',
  nodes: [],
  edges: [],
  schedule: DEFAULT_SCHEDULE,
};

const STEP_STATUS: Record<JobStepRunSummary['status'], JobNodeStatus> = {
  pending: 'pending',
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
  canceled: 'canceled',
};

const TERMINAL = new Set(['success', 'error', 'canceled']);

const POLL_INTERVAL_MS = 1000;

export interface JobEditorViewProps {
  job: JobDetail | null;
  workflows: WorkflowSummary[];
  connections: Array<{ id: string; name: string; type: string }>;
  resourceFiles: Array<{ name: string; path: string }>;
}

export function JobEditorView({ job, workflows, connections, resourceFiles }: JobEditorViewProps) {
  const navigate = useNavigate();
  const name = useJobEditorStore((s) => s.name);
  const dirty = useJobEditorStore((s) => s.dirty);
  const past = useJobEditorStore((s) => s.past);
  const future = useJobEditorStore((s) => s.future);
  const loadDraft = useJobEditorStore((s) => s.load);
  const addNode = useJobEditorStore((s) => s.addNode);
  const undo = useJobEditorStore((s) => s.undo);
  const redo = useJobEditorStore((s) => s.redo);
  const autoLayout = useJobEditorStore((s) => s.autoLayout);
  const { colorMode } = useCanvasTheme();

  const jobId = job?.id ?? null;

  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 有未保存更改时点返回：弹出保存确认 */
  const [exitOpen, setExitOpen] = useState(false);

  const [runId, setRunId] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<JobRunSummary | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [steps, setSteps] = useState<JobStepRunSummary[]>([]);
  /** 最近一次已完成运行的结果，用于进入编辑器时先展示历史输出。 */
  const [lastRun, setLastRun] = useState<{ run: JobRunSummary; steps: JobStepRunSummary[] } | null>(null);
  const finishedRunRef = useRef<string | null>(null);

  /** 编辑器数据装载：Job 详情 → 草稿；新建时为空白板。 */
  useEffect(() => {
    loadDraft(job ? fromDetail(job) : EMPTY_DRAFT);
    setRunId(null);
    setRunSummary(null);
    setRunStatus(null);
    setSteps([]);
    setLastRun(null);
    finishedRunRef.current = null;
    setReady(true);
  }, [job, loadDraft]);

  // 载入最近一次运行的详情（含步骤输出）；有正在进行的运行时以轮询结果为准。
  const refreshLatestRun = useCallback(async () => {
    if (!jobId) {
      setLastRun(null);
      return;
    }
    try {
      const res = await api.get<{ items: JobRunSummary[] }>(`/api/jobs/${jobId}/runs?limit=1`);
      const latest = res.items[0];
      if (!latest) {
        setLastRun(null);
        return;
      }
      const detail = await api.get<{ jobRun: JobRunSummary; steps: JobStepRunSummary[] }>(
        `/api/job-runs/${latest.id}`,
      );
      setLastRun({ run: detail.jobRun, steps: detail.steps });
    } catch {
      /* 最近一次运行加载失败不阻塞编辑 */
    }
  }, [jobId]);

  useEffect(() => {
    void refreshLatestRun();
  }, [refreshLatestRun]);

  const lookups = useMemo<NodeLookups>(() => ({
    workflowNames: new Map(workflows.map((item) => [item.id, item.name])),
    connectionNames: new Map(connections.map((item) => [item.id, item.name])),
  }), [workflows, connections]);

  const running = runId !== null && !TERMINAL.has(runStatus ?? 'queued');
  const locked = running || saving;

  const statuses = useMemo(() => {
    const map = new Map<string, JobNodeStatus>();
    for (const step of steps) {
      if (step.node_key) map.set(step.node_key, STEP_STATUS[step.status]);
    }
    return map;
  }, [steps]);

  const save = useCallback(async (): Promise<string | null> => {
    const state = useJobEditorStore.getState();
    if (!state.name.trim()) {
      toast.error('请填写 Job 名称');
      return null;
    }
    if (state.nodes.length === 0) {
      toast.error('请至少添加一个节点');
      return null;
    }
    const bad = state.nodes.find((node) => nodeIssues(node).length > 0);
    if (bad) {
      state.select(bad.key);
      toast.error(`节点「${bad.name}」配置未完成：${nodeIssues(bad).join('、')}`);
      return null;
    }
    if (state.schedule.enabled && state.schedule.freqType === 'cron' && !state.schedule.cronExpr.trim()) {
      toast.error('请填写 cron 表达式');
      return null;
    }
    setSaving(true);
    try {
      const body = state.toBody();
      if (!jobId) {
        const created = await api.post<{ id: string }>('/api/jobs', { body });
        useJobEditorStore.getState().markSaved();
        toast.success('保存成功');
        navigate(`/jobs/${created.id}`, { replace: true });
        return created.id;
      }
      await api.put(`/api/jobs/${jobId}`, { body });
      useJobEditorStore.getState().markSaved();
      toast.success('保存成功');
      return jobId;
    } catch (err) {
      toast.error((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [jobId, navigate]);

  // ⌘S 保存
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  // 未保存时离开页面给出浏览器原生提示
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // 运行轮询：1s 一次，终态停止
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const detail = await api.get<{ jobRun: JobRunSummary; steps: JobStepRunSummary[] }>(
          `/api/job-runs/${runId}`,
        );
        if (cancelled) return;
        setSteps(detail.steps);
        setRunSummary(detail.jobRun);
        setRunStatus(detail.jobRun.status);
      } catch {
        /* 单次轮询失败忽略，下一轮重试 */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId]);

  // 终态提示（只提示一次）
  useEffect(() => {
    if (!runId || !runStatus || !TERMINAL.has(runStatus)) return;
    if (finishedRunRef.current === runId) return;
    finishedRunRef.current = runId;
    const action = {
      label: '查看详情',
      onClick: () => navigate(`/job-runs/${runId}`),
    };
    if (runStatus === 'success') toast.success('运行成功', { action });
    else if (runStatus === 'canceled') toast.warning('运行已取消', { action });
    else toast.error('运行失败', { action });
  }, [runId, runStatus, navigate]);

  async function runNow(): Promise<void> {
    if (!jobId) return;
    const state = useJobEditorStore.getState();
    if (state.nodes.length === 0 || state.nodes.every((node) => node.mode !== 'run')) {
      toast.error('没有可执行的节点');
      return;
    }
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${jobId}/runs`);
      state.select(null);
      setSteps([]);
      setRunSummary(null);
      setRunStatus('queued');
      setRunId(res.jobRunId);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function goBack(): void {
    if (dirty) {
      setExitOpen(true);
      return;
    }
    navigate('/jobs');
  }

  /** 保存成功后离开；校验或保存失败时保持对话框，由 toast 说明原因 */
  async function saveAndLeave(): Promise<void> {
    if (await save()) {
      setExitOpen(false);
      navigate('/jobs');
    }
  }

  function discardAndLeave(): void {
    setExitOpen(false);
    navigate('/jobs');
  }

  function handleAdd(type: JobStepType): void {
    addNode(type);
    toast.success(`已添加「${type === 'workflow' ? '运行工作流' : type === 'sql' ? '运行 SQL' : '加载成模型'}」节点`);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <JobToolbar
        name={name}
        dirty={dirty}
        locked={locked}
        saving={saving}
        running={running}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onBack={goBack}
        onUndo={undo}
        onRedo={redo}
        onAutoLayout={autoLayout}
        onOpenSettings={() => setSettingsOpen(true)}
        onSave={() => void save()}
        onRun={() => void runNow()}
      />

      <JobPalette onAdd={handleAdd} disabled={locked} />

      <div className="flex min-h-0 flex-1">
        <JobInspector
          workflows={workflows}
          connections={connections}
          resourceFiles={resourceFiles}
          locked={locked}
        />
        <div className="min-w-0 flex-1">
          {ready && (
            <ReactFlowProvider>
              <JobCanvas lookups={lookups} statuses={statuses} locked={locked} />
            </ReactFlowProvider>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-card/40">
        <JobRunOutputPanel
          run={runId ? runSummary : (lastRun?.run ?? null)}
          steps={runId ? steps : (lastRun?.steps ?? [])}
          hasJob={Boolean(jobId)}
          active={running}
        />
      </div>

      <JobSettingsDialog
        open={settingsOpen}
        locked={locked}
        onClose={() => setSettingsOpen(false)}
      />

      <UnsavedChangesDialog
        open={exitOpen}
        saving={saving}
        onCancel={() => setExitOpen(false)}
        onDiscard={discardAndLeave}
        onSave={() => void saveAndLeave()}
        description="当前 Job 有未保存的更改，离开后将丢失。是否保存？"
      />

      <Toaster position="top-center" theme={colorMode} />
    </div>
  );
}
