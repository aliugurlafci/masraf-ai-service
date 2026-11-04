import { QueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { isApiError } from './errors';
import type { Api } from './endpoints';

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (api === null) {
    throw new Error('useApi() must be used inside <ApiProvider>');
  }
  return api;
}

/** Only transport failures and gateway errors are retried automatically; 4xx/429/503 are shown with their own retry UI. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (!isApiError(error)) {
    return false;
  }
  const transient = error.kind === 'network' || error.status === 502 || error.status === 504;
  return transient && failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
