import {
  focusManager,
  keepPreviousData,
  QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { ApiError } from './client';
import {
  getBen,
  getKategoriler,
  getMasraf,
  getMasraflar,
  getOnaylar,
  getOzet,
  previewFlow,
} from './endpoints';
import type { Kapsam, MasrafDetay, MasrafDurum, MasrafListesi, OnayListeDurumu, OnizlemeIstegi } from './types';

export const PAGE_SIZE = 20;

export const queryKeys = {
  ben: ['ben'] as const,
  ozet: ['ozet'] as const,
  kategoriler: ['kategoriler'] as const,
  masraflarAll: ['masraflar'] as const,
  masraflar: (kapsam: Kapsam, durum: readonly MasrafDurum[], q: string) => ['masraflar', kapsam, durum, q] as const,
  masraf: (id: number) => ['masraf', id] as const,
  onaylarAll: ['onaylar'] as const,
  onaylar: (durum: OnayListeDurumu) => ['onaylar', durum] as const,
  onizle: (body: OnizlemeIstegi) => ['onizle', body] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        // Client errors (4xx) will not change on retry; network and server errors get two more tries.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

/** React Native has no window focus; refetch stale queries when the app comes to the foreground. */
export function useAppFocusManager(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const sub = AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
    return () => sub.remove();
  }, []);
}

export function useBen(enabled = true) {
  return useQuery({
    queryKey: queryKeys.ben,
    queryFn: ({ signal }) => getBen({ signal }),
    enabled,
    staleTime: 10_000,
    // The pending approvals badge stays fresh while the app is open.
    refetchInterval: 60_000,
  });
}

export function useOzet() {
  return useQuery({ queryKey: queryKeys.ozet, queryFn: ({ signal }) => getOzet({ signal }) });
}

export function useKategoriler() {
  return useQuery({
    queryKey: queryKeys.kategoriler,
    queryFn: ({ signal }) => getKategoriler({ signal }),
    staleTime: 10 * 60_000,
    select: (list) => list.filter((k) => k.aktif).sort((a, b) => a.sira - b.sira),
  });
}

export function useMasrafList(kapsam: Kapsam, durum: readonly MasrafDurum[], q: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.masraflar(kapsam, durum, q),
    queryFn: ({ pageParam, signal }) =>
      getMasraflar({ kapsam, durum, q: q.trim() === '' ? undefined : q.trim(), sayfa: pageParam, adet: PAGE_SIZE }, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last: MasrafListesi) => (last.sayfa * last.adet < last.toplam ? last.sayfa + 1 : undefined),
    placeholderData: keepPreviousData,
  });
}

export function useMasraf(id: number) {
  return useQuery({
    queryKey: queryKeys.masraf(id),
    queryFn: ({ signal }) => getMasraf(id, { signal }),
    enabled: Number.isInteger(id) && id > 0,
  });
}

export function useOnaylar(durum: OnayListeDurumu) {
  return useQuery({ queryKey: queryKeys.onaylar(durum), queryFn: ({ signal }) => getOnaylar(durum, { signal }) });
}

/** Approval route preview; `body` is null while there is nothing to preview (no amount yet). */
export function useOnizleme(body: OnizlemeIstegi | null) {
  return useQuery({
    queryKey: queryKeys.onizle(body ?? { tutar: 0 }),
    queryFn: ({ signal }) => previewFlow(body as OnizlemeIstegi, { signal }),
    enabled: body !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** After any change to a form: store the fresh detail and refresh every list that may show it. */
export function useMasrafChanged(): (detail: MasrafDetay) => Promise<void> {
  const client = useQueryClient();
  return async (detail) => {
    client.setQueryData(queryKeys.masraf(detail.id), detail);
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.masraflarAll }),
      client.invalidateQueries({ queryKey: queryKeys.onaylarAll }),
      client.invalidateQueries({ queryKey: queryKeys.ozet }),
      client.invalidateQueries({ queryKey: queryKeys.ben }),
    ]);
  };
}

export const flattenPages = (data: InfiniteData<MasrafListesi> | undefined) => data?.pages.flatMap((p) => p.kayitlar) ?? [];
