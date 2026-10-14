import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { WorkflowDetailPage } from './pages/WorkflowDetailPage.js';
import { WorkflowListPage } from './pages/WorkflowListPage.js';
import { WorkflowUploadPage } from './pages/WorkflowUploadPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/workflows" element={<WorkflowListPage />} />
            <Route path="/workflows/new" element={<WorkflowUploadPage />} />
            <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
            {/* Task 24 在此追加 运行详情 / 连接 / 用户 / 设置 路由 */}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
