import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Bot,
  Boxes,
  Compass,
  Database,
  FolderOpen,
  Home,
  LayoutDashboard,
  ListChecks,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../auth.js';
import { ROLE_LABELS } from '../roles.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

const COLLAPSED_KEY = 'hustserver.sidebar.collapsed';

function NavItem({
  to,
  icon: Icon,
  label,
  collapsed,
  end,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-lg py-2 text-sm transition-colors ${
          collapsed ? 'justify-center px-0' : 'px-3'
        } ${
          isActive
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

export function Layout() {
  const { user, logout, hasCap } = useAuth();
  const navigate = useNavigate();
  const roleLabels = user ? user.roles.map((r) => ROLE_LABELS[r]).join('、') : '';
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  function toggleCollapsed(): void {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 忽略隐私模式等场景下的写入失败 */
      }
      return next;
    });
  }

  return (
    <div className="flex min-h-screen bg-muted/40 text-foreground">
      <aside
        className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 ${
          collapsed ? 'w-[4.25rem]' : 'w-56'
        }`}
      >
        <div
          className={`flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
            <Boxes className="h-4 w-4" />
          </span>
          {!collapsed && <span className="truncate font-semibold">个人数据工作台</span>}
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {hasCap('admin') && <NavItem to="/" end icon={Home} label="主页" collapsed={collapsed} />}
          {hasCap('workflow') && (
            <NavItem to="/workflows" icon={Workflow} label="工作流" collapsed={collapsed} />
          )}
          {hasCap('dashboard.view') && (
            <NavItem to="/dashboards" icon={LayoutDashboard} label="仪表板" collapsed={collapsed} />
          )}
          {hasCap('dashboard.view') && (
            <NavItem to="/models" icon={Database} label="数据模型" collapsed={collapsed} />
          )}
          {hasCap('connection.use') && (
            <NavItem to="/explore" icon={Compass} label="数据探索" collapsed={collapsed} />
          )}
          {hasCap('connection.use') && (
            <NavItem to="/assistant" icon={Bot} label="AI智能体" collapsed={collapsed} />
          )}
          {hasCap('resources') && (
            <NavItem to="/resources" icon={FolderOpen} label="资源管理" collapsed={collapsed} />
          )}
          {hasCap('connection.manage') && (
            <NavItem to="/connections" icon={Plug} label="连接" collapsed={collapsed} />
          )}
          {hasCap('job') && <NavItem to="/jobs" icon={ListChecks} label="Job" collapsed={collapsed} />}
          {hasCap('admin') && (
            <>
              <div aria-hidden className="my-1 h-px bg-border" />
              <NavItem to="/audit" icon={ShieldCheck} label="系统审计" collapsed={collapsed} />
              <NavItem to="/users" icon={Users} label="用户" collapsed={collapsed} />
              <NavItem to="/settings" icon={Settings} label="设置" collapsed={collapsed} />
            </>
          )}
        </nav>

        <div className="shrink-0 border-t border-border p-2">
          {!collapsed && (
            <div className="mb-2 px-1">
              <div className="truncate text-sm font-medium">{user?.username}</div>
              {roleLabels ? (
                <div className="mt-1">
                  <Badge tone="neutral">{roleLabels}</Badge>
                </div>
              ) : null}
            </div>
          )}
          <div className={collapsed ? 'flex flex-col items-center gap-1' : 'flex items-center gap-1'}>
            <Button
              variant="ghost"
              size="sm"
              title="退出登录"
              className={collapsed ? 'w-9 justify-center px-0' : 'flex-1 justify-start'}
              onClick={() => void logout().then(() => navigate('/login'))}
            >
              <LogOut className="text-destructive" />
              {!collapsed && '退出'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title={collapsed ? '展开菜单' : '收起菜单'}
              className={collapsed ? 'w-9 justify-center px-0' : 'justify-center'}
              onClick={toggleCollapsed}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              {!collapsed && '收起'}
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
