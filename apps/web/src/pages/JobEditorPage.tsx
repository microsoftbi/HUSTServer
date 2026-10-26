import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { JobEditorView } from '../features/jobs/JobEditorView.js';
import { useCanvasThemeOnDocument } from '../features/theme/themeStore.js';
import type { JobDetail, WorkflowSummary } from '../types.js';

interface ConnectionOption {
  id: string;
  name: string;
  type: string;
}

/** Job 编辑器壳：只负责加载工作流/连接/资源文件与 Job 详情，装配画布交给 JobEditorView。 */
export function JobEditorPage() {
  const { id } = useParams();
  const isNew = !id;

  // 画布主题（设置中可切换），挂到 <html> 上，离开编辑器时自动还原。
  useCanvasThemeOnDocument();

  const [job, setJob] = useState<JobDetail | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [resourceFiles, setResourceFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);

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
    if (isNew) {
      setJob(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .get<JobDetail>(`/api/jobs/${id}`)
      .then((detail) => {
        if (!cancelled) setJob(detail);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>
    );
  }

  if (error || (!isNew && !job)) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-6">
        <ErrorNote>{error ?? '未找到该 Job'}</ErrorNote>
        <Link to="/jobs" className="text-sm text-primary hover:underline">
          返回 Job 列表
        </Link>
      </div>
    );
  }

  return (
    <JobEditorView
      job={job}
      workflows={workflows}
      connections={connections}
      resourceFiles={resourceFiles}
    />
  );
}
