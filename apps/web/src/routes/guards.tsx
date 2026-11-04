import type { Permission } from '@orc/shared';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { isApiError } from '../api/errors';
import { useCan, useMe } from '../auth/session';
import { ErrorView } from '../components/ErrorView';
import { Loading } from '../components/States';
import { ForbiddenView } from '../pages/errors/ErrorPages';

/** Loads `/auth/me`; 401 => `/login?next=<current path>` (contract §20.1). */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <main className="standalone">
        <Loading label="Checking your session" />
      </main>
    );
  }
  if (me.isError) {
    if (isApiError(me.error) && me.error.status === 401) {
      const next = encodeURIComponent(`${location.pathname}${location.search}`);
      return <Navigate to={`/login?next=${next}`} replace />;
    }
    return (
      <main className="standalone">
        <ErrorView error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  }
  return <Outlet />;
}

/** Renders the 403 page in place (no redirect) when the permission is missing. */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const can = useCan();
  if (!can(permission)) {
    return <ForbiddenView />;
  }
  return children;
}
