import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { DashboardEditorPage } from './features/dashboard/DashboardEditorPage.js';
import { DashboardListPage } from './features/dashboard/DashboardListPage.js';
import { ConnectionsPage } from './pages/ConnectionsPage.js';
import { HomePage } from './pages/HomePage.js';
import { JobEditorPage } from './pages/JobEditorPage.js';
import { JobListPage } from './pages/JobListPage.js';
import { JobRunDetailPage } from './pages/JobRunDetailPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { ResourcesPage } from './pages/ResourcesPage.js';
import { RunDetailPage } from './pages/RunDetailPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { WorkflowConnectionsPage } from './pages/WorkflowConnectionsPage.js';
import { WorkflowDesignerPage } from './pages/WorkflowDesignerPage.js';
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
            path="/workflows/:id/designer"
            element={
              <RequireAuth>
                <WorkflowDesignerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboards/:id"
            element={
              <RequireAuth>
                <DashboardEditorPage />
              </RequireAuth>
            }
          />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/workflows" element={<WorkflowListPage />} />
            <Route path="/dashboards" element={<DashboardListPage />} />
            <Route path="/workflows/new" element={<WorkflowUploadPage />} />
            <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
            <Route path="/workflows/:id/connections" element={<WorkflowConnectionsPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/jobs" element={<JobListPage />} />
            <Route path="/jobs/new" element={<JobEditorPage />} />
            <Route path="/jobs/:id" element={<JobEditorPage />} />
            <Route path="/job-runs/:id" element={<JobRunDetailPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
