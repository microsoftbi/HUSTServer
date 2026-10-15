import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded ${isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`;

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="flex items-center gap-4 border-b bg-white px-6 py-3">
        <span className="font-semibold">HUSTServer</span>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink to="/workflows" className={linkClass}>工作流</NavLink>
          <NavLink to="/dashboards" className={linkClass}>仪表板</NavLink>
          <NavLink to="/resources" className={linkClass}>资源管理</NavLink>
          <NavLink to="/connections" className={linkClass}>连接</NavLink>
          <NavLink to="/jobs" className={linkClass}>Job编排</NavLink>
          {user?.role === 'admin' && (
            <>
              <NavLink to="/users" className={linkClass}>用户</NavLink>
              <NavLink to="/settings" className={linkClass}>设置</NavLink>
            </>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-slate-500">{user?.username}（{user?.role === 'admin' ? '管理员' : '普通用户'}）</span>
          <button
            className="rounded border px-3 py-1 text-slate-600 hover:bg-slate-100"
            onClick={() => void logout().then(() => navigate('/login'))}
          >
            退出
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
