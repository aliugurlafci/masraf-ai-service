import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { AppProviders } from '../App';
import { ApiClient } from '../api/client';
import { Api } from '../api/endpoints';
import { AppRoutes } from '../routes/AppRoutes';

export function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Full application routes at `path` with fresh providers. */
export function renderApp(path: string) {
  const queryClient = createTestQueryClient();
  const api = new Api(new ApiClient());
  const user = userEvent.setup();
  const utils = render(
    <AppProviders api={api} queryClient={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationDisplay />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, queryClient, api, user };
}

/** One component mounted at `routePath` (e.g. `/tasks/:taskId`) and opened at `path`. */
export function renderRoute(ui: ReactElement, { path, routePath }: { path: string; routePath: string }) {
  const queryClient = createTestQueryClient();
  const api = new Api(new ApiClient());
  const user = userEvent.setup();
  const utils = render(
    <AppProviders api={api} queryClient={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={ui} />
        </Routes>
        <LocationDisplay />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, queryClient, api, user };
}
