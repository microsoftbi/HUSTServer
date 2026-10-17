import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, type SessionUser } from './api.js';
import type { Capability, Role } from './roles.js';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  hasCap(cap: Capability): boolean;
  hasRole(role: Role): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<SessionUser>('/api/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const me = await api.post<SessionUser>('/api/auth/login', { body: { username, password } });
    setUser(me);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login,
      logout,
      refresh,
      hasCap: (cap) => !!user?.capabilities.includes(cap),
      hasRole: (role) => !!user?.roles.includes(role),
    }),
    [user, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

export function RequireCap({ cap, children }: { cap: Capability; children: ReactNode }) {
  const { loading, hasCap } = useAuth();
  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!hasCap(cap)) return <div className="p-6 text-sm text-muted-foreground">无权访问。</div>;
  return <>{children}</>;
}
