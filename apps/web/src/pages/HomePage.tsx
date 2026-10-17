import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, LayoutDashboard, ListChecks, Plug, Users, Workflow } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { Card } from '../components/ui/card.js';
import { PageHeader } from '../components/ui/page-header.js';
import { CreationTrends } from '../components/home/CreationTrends.js';

/** 顶部数值卡片（顺序即展示顺序） */
const CARDS = [
  { key: 'workflows', to: '/workflows', icon: Workflow, title: '工作流' },
  { key: 'dashboards', to: '/dashboards', icon: LayoutDashboard, title: '仪表板' },
  { key: 'models', to: '/models', icon: Database, title: '数据模型' },
  { key: 'connections', to: '/connections', icon: Plug, title: '连接' },
  { key: 'jobs', to: '/jobs', icon: ListChecks, title: 'Job' },
  { key: 'users', to: '/users', icon: Users, title: '用户' },
] as const;

type CardKey = (typeof CARDS)[number]['key'];

/** 统计值加载态：加载中显示「…」，失败显示「—」 */
type MetricState =
  | { status: 'loading' }
  | { status: 'ok'; value: number }
  | { status: 'error'; reason: string };

function initialCounts(): Record<CardKey, MetricState> {
  return Object.fromEntries(CARDS.map((c) => [c.key, { status: 'loading' }])) as Record<
    CardKey,
    MetricState
  >;
}

export function HomePage() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<Record<CardKey, MetricState>>(initialCounts);

  useEffect(() => {
    let cancelled = false;
    const loaders: Record<CardKey, () => Promise<number>> = {
      workflows: async () => (await api.get<unknown[]>('/api/workflows')).length,
      dashboards: async () => (await api.get<unknown[]>('/api/dashboards')).length,
      models: async () => (await api.get<{ items: unknown[] }>('/api/models')).items.length,
      connections: async () => (await api.get<unknown[]>('/api/connections')).length,
      jobs: async () => (await api.get<{ items: unknown[] }>('/api/jobs')).items.length,
      users: async () => (await api.get<unknown[]>('/api/admin/users')).length,
    };

    void Promise.allSettled(CARDS.map((c) => loaders[c.key]())).then((results) => {
      if (cancelled) return;
      const next = initialCounts();
      CARDS.forEach((c, i) => {
        const res = results[i];
        if (!res) return;
        next[c.key] =
          res.status === 'fulfilled'
            ? { status: 'ok', value: res.value }
            : { status: 'error', reason: (res.reason as Error).message };
      });
      setCounts(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`欢迎，${user?.username ?? ''}`}
        description="一站式数据工作台：编排工作流、搭建仪表板、运行定时任务。"
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {CARDS.map((card) => {
          const state = counts[card.key];
          return (
            <Card key={card.key} className="transition-colors hover:border-primary/40">
              <Link
                className="flex items-start gap-3 p-4"
                to={card.to}
                title={state.status === 'error' ? `加载失败：${state.reason}` : undefined}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <card.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs text-muted-foreground">{card.title}</span>
                  <span className="block text-2xl font-semibold tabular-nums">
                    {state.status === 'loading'
                      ? '…'
                      : state.status === 'ok'
                        ? state.value.toLocaleString('en-US')
                        : '—'}
                  </span>
                </span>
              </Link>
            </Card>
          );
        })}
      </div>

      <CreationTrends />
    </div>
  );
}
