import { Route, Routes } from 'react-router';
import { Layout } from '../layout/Layout';
import { AccountPage } from '../pages/account/AccountPage';
import { AgentsPage } from '../pages/agents/AgentsPage';
import { AuditPage } from '../pages/audit/AuditPage';
import { DashboardPage } from '../pages/DashboardPage';
import { ForbiddenPage, NotFoundPage } from '../pages/errors/ErrorPages';
import { LoginPage } from '../pages/LoginPage';
import { ProjectDetailPage } from '../pages/project-detail/ProjectDetailPage';
import { ProjectsPage } from '../pages/projects/ProjectsPage';
import { SystemPage } from '../pages/system/SystemPage';
import { TaskDetailPage } from '../pages/task-detail/TaskDetailPage';
import { NewTaskPage } from '../pages/tasks/NewTaskPage';
import { TaskListPage } from '../pages/tasks/TaskListPage';
import { TeamsPage } from '../pages/teams/TeamsPage';
import { RequireAuth, RequirePermission } from './guards';

/** Route table of contract §20.1. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/403" element={<ForbiddenPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route
            index
            element={
              <RequirePermission permission="task:read:own">
                <DashboardPage />
              </RequirePermission>
            }
          />
          <Route
            path="projects"
            element={
              <RequirePermission permission="project:read">
                <ProjectsPage />
              </RequirePermission>
            }
          />
          <Route
            path="projects/:projectId"
            element={
              <RequirePermission permission="project:read">
                <ProjectDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="tasks"
            element={
              <RequirePermission permission="task:read:own">
                <TaskListPage />
              </RequirePermission>
            }
          />
          <Route
            path="tasks/new"
            element={
              <RequirePermission permission="task:create">
                <NewTaskPage />
              </RequirePermission>
            }
          />
          <Route
            path="tasks/:taskId"
            element={
              <RequirePermission permission="task:read:own">
                <TaskDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="agents"
            element={
              <RequirePermission permission="agent:read">
                <AgentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="teams"
            element={
              <RequirePermission permission="team:read">
                <TeamsPage />
              </RequirePermission>
            }
          />
          <Route
            path="system"
            element={
              <RequirePermission permission="system:read">
                <SystemPage />
              </RequirePermission>
            }
          />
          <Route
            path="audit"
            element={
              <RequirePermission permission="audit:read">
                <AuditPage />
              </RequirePermission>
            }
          />
          <Route
            path="account"
            element={
              <RequirePermission permission="token:manage:own">
                <AccountPage />
              </RequirePermission>
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
