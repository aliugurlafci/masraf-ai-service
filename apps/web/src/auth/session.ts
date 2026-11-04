import { useQuery } from '@tanstack/react-query';
import type { MeResponse, Permission } from '@orc/shared';
import { useCallback } from 'react';
import { useApi } from '../api/ApiContext';

export const ME_QUERY_KEY = ['me'] as const;

/** `GET /auth/me` through react-query (key `['me']`, contract §20.1). */
export function useMe() {
  const api = useApi();
  return useQuery<MeResponse>({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => api.me(signal),
    retry: false,
    staleTime: 60_000,
  });
}

/** Permission predicate for the signed-in user (false until `/auth/me` resolved). */
export function useCan(): (permission: Permission) => boolean {
  const me = useMe().data;
  return useCallback(
    (permission: Permission) => me?.permissions.includes(permission) ?? false,
    [me],
  );
}

/**
 * `next` targets are same-origin relative paths only: one leading slash, no scheme or
 * protocol-relative form, no backslashes or control characters.
 */
export function safeNext(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.length === 0 || raw.length > 2048) {
    return '/';
  }
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/';
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return '/';
    }
  }
  if (raw === '/login' || raw.startsWith('/login?')) {
    return '/';
  }
  return raw;
}
