import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireCap } from './auth.js';
import { Layout } from './components/Layout.js';
import { DashboardEditorPage } from './features/dashboard/DashboardEditorPage.js';
import { DashboardListPage } from './features/dashboard/DashboardListPage.js';
import { ConnectionsPage } from './pages/ConnectionsPage.js';
import { HomePage } from './pages/HomePage.js';
import { JobEditorPage } from './pages/JobEditorPage.js';
import { JobListPage } from './pages/JobListPage.js';
import { JobRunDetailPage } from './pages/JobRunDetailPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
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
                <RequireCap cap="workflow">
                  <WorkflowDesignerPage />
                </RequireCap>
              </RequireAuth>
            }
          />
          <Route
            path="/dashboards/:id"
            element={
              <RequireAuth>
                <RequireCap cap="dashboard.view">
                  <DashboardEditorPage />
                </RequireCap>
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
            <Route
              path="/workflows"
              element={
                <RequireCap cap="workflow">
                  <WorkflowListPage />
                </RequireCap>
              }
            />
            <Route
              path="/dashboards"
              element={
                <RequireCap cap="dashboard.view">
                  <DashboardListPage />
                </RequireCap>
              }
            />
            <Route
              path="/workflows/new"
              element={
                <RequireCap cap="workflow">
                  <WorkflowUploadPage />
                </RequireCap>
              }
            />
            <Route
              path="/workflows/:id"
              element={
                <RequireCap cap="workflow">
                  <WorkflowDetailPage />
                </RequireCap>
              }
            />
            <Route
              path="/workflows/:id/connections"
              element={
                <RequireCap cap="workflow">
                  <WorkflowConnectionsPage />
                </RequireCap>
              }
            />
            <Route
              path="/runs/:id"
              element={
                <RequireCap cap="job">
                  <RunDetailPage />
                </RequireCap>
              }
            />
            <Route
              path="/jobs"
              element={
                <RequireCap cap="job">
                  <JobListPage />
                </RequireCap>
              }
            />
            <Route
              path="/jobs/new"
              element={
                <RequireCap cap="job">
                  <JobEditorPage />
                </RequireCap>
              }
            />
            <Route
              path="/jobs/:id"
              element={
                <RequireCap cap="job">
                  <JobEditorPage />
                </RequireCap>
              }
            />
            <Route
              path="/job-runs/:id"
              element={
                <RequireCap cap="job">
                  <JobRunDetailPage />
                </RequireCap>
              }
            />
            <Route
              path="/connections"
              element={
                <RequireCap cap="connection.manage">
                  <ConnectionsPage />
                </RequireCap>
              }
            />
            <Route
              path="/resources"
              element={
                <RequireCap cap="resources">
                  <ResourcesPage />
                </RequireCap>
              }
            />
            <Route
              path="/models"
              element={
                <RequireCap cap="dashboard.view">
                  <ModelsPage />
                </RequireCap>
              }
            />
            <Route
              path="/users"
              element={
                <RequireCap cap="admin">
                  <UsersPage />
                </RequireCap>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireCap cap="admin">
                  <SettingsPage />
                </RequireCap>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
