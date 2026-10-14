import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { ConnectionsPage } from './pages/ConnectionsPage.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RunDetailPage } from './pages/RunDetailPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { UsersPage } from './pages/UsersPage.js';
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
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
