import { Link } from 'react-router-dom';
import { LayoutDashboard, ListChecks, Workflow } from 'lucide-react';
import { useAuth } from '../auth.js';
import type { Capability } from '../roles.js';
import { Card } from '../components/ui/card.js';
import { PageHeader } from '../components/ui/page-header.js';

const ENTRIES: {
  to: string;
  cap: Capability;
  icon: typeof Workflow;
  title: string;
  description: string;
}[] = [
  {
    to: '/workflows',
    cap: 'workflow',
    icon: Workflow,
    title: '工作流',
    description: '上传、设计与运行数据工作流',
  },
  {
    to: '/dashboards',
    cap: 'dashboard.view',
    icon: LayoutDashboard,
    title: '仪表板',
    description: '19 种视觉对象的数据看板',
  },
  {
    to: '/jobs',
    cap: 'job',
    icon: ListChecks,
    title: 'Job 编排',
    description: '把工作流与 SQL 串成定时流水线',
  },
];

export function HomePage() {
  const { user, hasCap } = useAuth();
  return (
    <div className="space-y-4">
      <PageHeader
        title={`欢迎，${user?.username ?? ''}`}
        description="一站式数据工作台：编排工作流、搭建仪表板、运行定时任务。"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {ENTRIES.filter((entry) => hasCap(entry.cap)).map((entry) => (
          <Card key={entry.to} className="transition-colors hover:border-primary/40">
            <Link className="flex items-start gap-3 p-4" to={entry.to}>
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <entry.icon className="h-4 w-4" />
              </span>
              <span className="space-y-1">
                <span className="block font-medium">{entry.title}</span>
                <span className="block text-xs text-muted-foreground">{entry.description}</span>
              </span>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
