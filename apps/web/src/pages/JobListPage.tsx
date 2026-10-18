import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Download, ListChecks, Pencil, Play, Trash2, Upload } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { ApiClientError, api } from '../api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { EmptyState } from '../components/ui/empty-state.js';
import { ErrorNote } from '../components/ui/error-note.js';
import { PageHeader } from '../components/ui/page-header.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { RUN_STATUS_TONE, describeSchedule } from '../jobDisplay.js';
import type { JobSummary } from '../types.js';

interface ExportFile {
  kind: string;
  version: number;
  exportedAt: number;
  job: unknown;
}

/** 把后端返回的 Job 导出对象下载为 .job.json 文件 */
function downloadExport(file: ExportFile, name: string) {
  const text = JSON.stringify(file, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[/\\?%*:|"<>]/g, '_')}.job.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function JobListPage() {
  const [items, setItems] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  async function load() {
    try {
      const res = await api.get<{ items: JobSummary[] }>('/api/jobs');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(job: JobSummary) {
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${job.id}/runs`);
      navigate(`/job-runs/${res.jobRunId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(job: JobSummary) {
    if (!window.confirm(`确定删除 Job「${job.name}」？其运行历史将一并删除。`)) return;
    await api.del(`/api/jobs/${job.id}`);
    await load();
  }

  async function exportJob(job: JobSummary) {
    try {
      const file = await api.get<ExportFile>(`/api/jobs/${job.id}/export`);
      downloadExport(file, job.name);
      toast.success(`已导出「${job.name}」`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = ''; // 清空以便同一文件可重复选择
    if (!file) return;

    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError('文件不是合法的 JSON');
      return;
    }

    setImporting(true);
    try {
      const res = await api.post<{ id: string; name: string; warnings: string[] }>('/api/jobs/import', {
        body: parsed,
      });
      toast.success(`已导入「${res.name}」`);
      for (const warning of res.warnings ?? []) toast.warning(warning);
      navigate(`/jobs/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? (err.detail ?? err.message) : (err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Job 编排" description="把工作流、SQL 与加载模型串成可定时运行的流水线。">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => void importFile(e)}
        />
        <Button variant="outline" disabled={importing} onClick={() => fileInputRef.current?.click()}>
          <Upload />
          {importing ? '导入中…' : '导入 Job'}
        </Button>
        <Button asChild>
          <Link to="/jobs/new">新建 Job</Link>
        </Button>
      </PageHeader>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="暂无 Job"
            description="点击右上角「新建 Job」，把工作流、SQL 与加载模型串成流水线。"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>名称</TableHead>
                <TableHead className="w-24">步骤数</TableHead>
                <TableHead className="w-64">调度</TableHead>
                <TableHead className="w-28">最近运行</TableHead>
                <TableHead className="w-48">更新时间</TableHead>
                <TableHead className="w-56 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Link className="font-medium hover:text-primary hover:underline" to={`/jobs/${job.id}`}>
                      {job.name}
                    </Link>
                    {job.description && <div className="text-xs text-muted-foreground">{job.description}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{job.stepCount}</TableCell>
                  <TableCell className="text-muted-foreground">{describeSchedule(job)}</TableCell>
                  <TableCell>
                    {job.lastRun ? (
                      <Link to={`/job-runs/${job.lastRun.id}`}>
                        <Badge dot tone={RUN_STATUS_TONE[job.lastRun.status] ?? 'neutral'}>
                          {job.lastRun.status}
                        </Badge>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">从未运行</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(job.updated_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void exportJob(job)}>
                        <Download />
                        导出
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void run(job)}>
                        <Play />
                        运行
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/jobs/${job.id}`}>
                          <Pencil />
                          编辑
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => void remove(job)}
                      >
                        <Trash2 />
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {items.length > 0 && <p className="px-1 text-xs text-muted-foreground">共 {items.length} 个 Job</p>}

      <Toaster position="bottom-left" />
    </div>
  );
}
