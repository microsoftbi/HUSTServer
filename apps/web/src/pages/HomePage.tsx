import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">欢迎，{user?.username}</h1>
      <p className="text-slate-600">请从左侧导航进入 <Link className="text-blue-600 underline" to="/workflows">工作流</Link>。</p>
    </div>
  );
}
