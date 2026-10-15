import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">欢迎，{user?.username}</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link className="rounded border bg-white p-4 hover:border-blue-500" to="/workflows">
          <div className="font-medium">工作流</div>
          <div className="text-sm text-slate-500">上传、设计与运行数据工作流</div>
        </Link>
        <Link className="rounded border bg-white p-4 hover:border-blue-500" to="/jobs">
          <div className="font-medium">Job 编排</div>
          <div className="text-sm text-slate-500">把工作流与 SQL 串成定时流水线</div>
        </Link>
      </div>
    </div>
  );
}
