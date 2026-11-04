import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@orc/shared';
import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useApi } from '../api/ApiContext';
import { useCan, useMe } from '../auth/session';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { applyThemePreference, readThemePreference } from '../lib/theme';
import type { ThemePreference } from '../lib/theme';

interface NavItem {
  to: string;
  label: string;
  permission: Permission;
  isActive: (pathname: string) => boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', permission: 'task:read:own', isActive: (p) => p === '/' },
  {
    to: '/tasks',
    label: 'Tasks',
    permission: 'task:read:own',
    isActive: (p) => p === '/tasks' || (p.startsWith('/tasks/') && p !== '/tasks/new'),
  },
  { to: '/tasks/new', label: 'New task', permission: 'task:create', isActive: (p) => p === '/tasks/new' },
  { to: '/projects', label: 'Projects', permission: 'project:read', isActive: (p) => p.startsWith('/projects') },
  { to: '/agents', label: 'Agents', permission: 'agent:read', isActive: (p) => p.startsWith('/agents') },
  { to: '/teams', label: 'Teams', permission: 'team:read', isActive: (p) => p.startsWith('/teams') },
  { to: '/system', label: 'System', permission: 'system:read', isActive: (p) => p.startsWith('/system') },
  { to: '/audit', label: 'Audit', permission: 'audit:read', isActive: (p) => p.startsWith('/audit') },
  { to: '/account', label: 'Account', permission: 'token:manage:own', isActive: (p) => p.startsWith('/account') },
];

function ThemeSelect() {
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  return (
    <label className="theme-select">
      <span className="visually-hidden">Theme</span>
      <select
        value={theme}
        onChange={(event) => {
          const value = event.target.value;
          const next: ThemePreference = value === 'light' || value === 'dark' ? value : 'system';
          setTheme(next);
          applyThemePreference(next);
        }}
      >
        <option value="system">System theme</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

export function Layout() {
  const api = useApi();
  const me = useMe().data;
  const can = useCan();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      api.client.setCsrfToken(null);
      queryClient.clear();
      void navigate('/login', { replace: true });
    },
  });

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          Claude Code Orchestrator
        </Link>
        <nav aria-label="Main" className="main-nav">
          <ul>
            {NAV_ITEMS.filter((item) => can(item.permission)).map((item) => {
              const active = item.isActive(location.pathname);
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={active ? 'nav-link active' : 'nav-link'}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="user-menu">
          <ThemeSelect />
          {me ? (
            <span className="user-name" title={`${me.user.username} (${me.user.role})`}>
              {me.user.displayName} <span className="muted">· {me.user.role}</span>
            </span>
          ) : null}
          {me?.authMethod === 'session' ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      <main id="main-content" className="content" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
