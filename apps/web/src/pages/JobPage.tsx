import { useSearchParams } from 'react-router-dom';
import { ListChecks, ScrollText } from 'lucide-react';
import { cn } from '../components/ui/utils.js';
import { JobListPage } from './JobListPage.js';
import { JobLogPage } from './JobLogPage.js';

const TABS = [
  { id: 'orchestrate', label: '编排', icon: ListChecks },
  { id: 'logs', label: '日志', icon: ScrollText },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Job 功能入口：顶部「编排 / 日志」两个页签，分别复用原 Job 编排与 Job 日志界面。 */
export function JobPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = params.get('tab') === 'logs' ? 'logs' : 'orchestrate';

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/40 p-1"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setParams(id === 'logs' ? { tab: 'logs' } : {}, { replace: true })}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs transition-colors',
                active
                  ? 'bg-background font-semibold text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'logs' ? <JobLogPage /> : <JobListPage />}
    </div>
  );
}
