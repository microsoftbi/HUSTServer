import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import { useAuth } from '../auth.js';
import { ROLE_LABELS } from '../roles.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-3 py-1.5 text-sm transition-colors ${
    isActive
      ? 'bg-primary/10 font-medium text-primary'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
  }`;

export function Layout() {
  const { user, logout, hasCap } = useAuth();
  const navigate = useNavigate();
  const roleLabels = user ? user.roles.map((r) => ROLE_LABELS[r]).join('、') : '';

  return (
    <div className="min-h-screen bg-muted/40 text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <span className="flex items-center gap-2 font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
              <Boxes className="h-4 w-4" />
            </span>
            HUSTServer
          </span>
          <nav className="flex flex-wrap items-center gap-1">
            {hasCap('workflow') && <NavLink to="/workflows" className={linkClass}>工作流</NavLink>}
            {hasCap('dashboard.view') && <NavLink to="/dashboards" className={linkClass}>仪表板</NavLink>}
            {hasCap('dashboard.view') && <NavLink to="/models" className={linkClass}>数据模型</NavLink>}
            {hasCap('resources') && <NavLink to="/resources" className={linkClass}>资源管理</NavLink>}
            {hasCap('connection.manage') && <NavLink to="/connections" className={linkClass}>连接</NavLink>}
            {hasCap('job') && <NavLink to="/jobs" className={linkClass}>Job编排</NavLink>}
            {hasCap('admin') && (
              <>
                <NavLink to="/users" className={linkClass}>用户</NavLink>
                <NavLink to="/settings" className={linkClass}>设置</NavLink>
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="flex items-center gap-2">
              <span className="font-medium">{user?.username}</span>
              {roleLabels ? <Badge tone="neutral">{roleLabels}</Badge> : null}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void logout().then(() => navigate('/login'))}>
              退出
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
