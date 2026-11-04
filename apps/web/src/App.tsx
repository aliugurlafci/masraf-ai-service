import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { ApiProvider, createQueryClient } from './api/ApiContext';
import { ApiClient } from './api/client';
import { Api } from './api/endpoints';
import { ME_QUERY_KEY } from './auth/session';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppRoutes } from './routes/AppRoutes';

/**
 * Wires the API client to react-query: a CSRF-recovery `/auth/me` refresh updates the `['me']`
 * cache, and a 401 from any data route re-validates the session (RequireAuth then redirects to login).
 */
function SessionSync({ api, queryClient }: { api: Api; queryClient: QueryClient }) {
  useEffect(() => {
    const offMe = api.client.onMe((me) => queryClient.setQueryData(ME_QUERY_KEY, me));
    const offUnauth = api.client.onUnauthenticated(() => {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    });
    return () => {
      offMe();
      offUnauth();
    };
  }, [api, queryClient]);
  return null;
}

export function AppProviders({
  api,
  queryClient,
  children,
}: {
  api: Api;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <SessionSync api={api} queryClient={queryClient} />
        {children}
      </ApiProvider>
    </QueryClientProvider>
  );
}

export function App() {
  const [api] = useState(() => new Api(new ApiClient()));
  const [queryClient] = useState(createQueryClient);
  return (
    <ErrorBoundary>
      <AppProviders api={api} queryClient={queryClient}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </ErrorBoundary>
  );
}
