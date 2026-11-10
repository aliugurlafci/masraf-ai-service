import {
  focusManager,
  keepPreviousData,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { config } from '@/config';

import { ApiError } from './client';
import {
  getAlanlar,
  getBen,
  getBildirimler,
  getKategoriler,
  getMasraf,
  getMasraflar,
  getOnaylar,
  getOzet,
  getSecenekler,
  markAllNotificationsRead,
  markNotificationRead,
  previewFlow,
  updatePreferences,
} from './endpoints';
import type {
  BenYaniti,
  BildirimListesi,
  Kapsam,
  MasrafDetay,
  MasrafDurum,
  MasrafListesi,
  OnayListeDurumu,
  OnizlemeIstegi,
  SecenekListesi,
} from './types';

export const PAGE_SIZE = 20;
/** Options asked per page in the option picker. */
export const OPTION_PAGE_SIZE = 50;

export const queryKeys = {
  ben: ['ben'] as const,
  ozet: ['ozet'] as const,
  kategoriler: ['kategoriler'] as const,
  alanlar: ['alanlar'] as const,
  secenekler: (anahtar: string, q: string) => ['secenekler', anahtar, q] as const,
  masraflarAll: ['masraflar'] as const,
  masraflar: (kapsam: Kapsam, durum: readonly MasrafDurum[], q: string) => ['masraflar', kapsam, durum, q] as const,
  masraf: (id: number) => ['masraf', id] as const,
  onaylarAll: ['onaylar'] as const,
  onaylar: (durum: OnayListeDurumu) => ['onaylar', durum] as const,
  bildirimler: ['bildirimler'] as const,
  onizle: (body: OnizlemeIstegi) => ['onizle', body] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        // Client errors (4xx) will not change on retry. A timeout already waited the full request time;
        // retrying it would keep the screen loading for minutes, so it shows the error (with retry) at
        // once. Network and server errors get two more quick tries.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          if (error instanceof ApiError && error.kod === 'zaman_asimi') return false;
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

/** The receipt field definitions and rules; they change rarely (an admin's work on the panel). */
export function useAlanlar() {
  return useQuery({
    queryKey: queryKeys.alanlar,
    queryFn: ({ signal }) => getAlanlar({ signal }),
    staleTime: 5 * 60_000,
  });
}

/** A liste field's options matching `q`, page by page (`fetchNextPage` for more). */
export function useSecenekler(anahtar: string, q: string, enabled = true) {
  const text = q.trim();
  return useInfiniteQuery({
    queryKey: queryKeys.secenekler(anahtar, text),
    queryFn: ({ pageParam, signal }) =>
      getSecenekler(anahtar, { q: text === '' ? undefined : text, sayfa: pageParam, adet: OPTION_PAGE_SIZE }, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last: SecenekListesi) => (last.sayfa * last.adet < last.toplam ? last.sayfa + 1 : undefined),
    enabled,
    staleTime: 5 * 60_000,
    // While the search text changes, the previous results stay until the new ones arrive.
    placeholderData: keepPreviousData,
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

/** How often a form with invoices still being read in the background is asked again. */
const PENDING_POLL_MS = Math.max(config.pollIntervalMs, 3000);

/** Whether the server is still reading some of the form's invoice files (failed ones do not change by themselves). */
export const isReadingInBackground = (detail: MasrafDetay): boolean => detail.bekleyenFaturalar.some((b) => b.durum !== 'hata');

export function useMasraf(id: number) {
  return useQuery({
    queryKey: queryKeys.masraf(id),
    // A bad id (e.g. a broken link) must end in "not found"; a disabled query would stay pending forever.
    queryFn: ({ signal }) =>
      Number.isInteger(id) && id > 0 ? getMasraf(id, { signal }) : Promise.reject(new ApiError(404, 'bulunamadi', 'Kayıt bulunamadı.')),
    // While invoices are read in the background, the form is asked again every few seconds. It stops when
    // they are done, when the screen closes and while the app is in the background.
    refetchInterval: (query) => (query.state.data !== undefined && isReadingInBackground(query.state.data) ? PENDING_POLL_MS : false),
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

/**
 * After any change to a form: store the fresh detail and refresh every list that may show it. The lists
 * refresh in the background: the change is already saved, so a slow or failed list request must not keep
 * the save button busy or show the save as failed (the user would then save the same form twice).
 */
export function useMasrafChanged(): (detail: MasrafDetay) => Promise<void> {
  const client = useQueryClient();
  return async (detail) => {
    client.setQueryData(queryKeys.masraf(detail.id), detail);
    for (const queryKey of [queryKeys.masraflarAll, queryKeys.onaylarAll, queryKeys.ozet, queryKeys.ben]) {
      client.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  };
}

export const flattenPages = (data: InfiniteData<MasrafListesi> | undefined) => data?.pages.flatMap((p) => p.kayitlar) ?? [];

// --- Notifications ---

export function useBildirimler() {
  return useInfiniteQuery({
    queryKey: queryKeys.bildirimler,
    queryFn: ({ pageParam, signal }) => getBildirimler(pageParam, PAGE_SIZE, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last: BildirimListesi) => (last.sayfa * last.adet < last.toplam ? last.sayfa + 1 : undefined),
  });
}

/** After a notification was read: the badge (`ben`) and the list are fetched again. */
function useNotificationsChanged(): () => void {
  const client = useQueryClient();
  return () => {
    for (const queryKey of [queryKeys.ben, queryKeys.bildirimler]) {
      client.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  };
}

export function useMarkRead() {
  const changed = useNotificationsChanged();
  return useMutation({ mutationFn: (id: number) => markNotificationRead(id), onSettled: changed });
}

export function useMarkAllRead() {
  const changed = useNotificationsChanged();
  return useMutation({ mutationFn: () => markAllNotificationsRead(), onSettled: changed });
}

/** The e-mail preference: the switch moves at once (optimistic) and goes back when the server refuses. */
export function useMailPreference() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mailBildirim: boolean) => updatePreferences({ mailBildirim }),
    onMutate: async (mailBildirim) => {
      await client.cancelQueries({ queryKey: queryKeys.ben });
      const previous = client.getQueryData<BenYaniti>(queryKeys.ben);
      if (previous !== undefined) {
        client.setQueryData<BenYaniti>(queryKeys.ben, { ...previous, kullanici: { ...previous.kullanici, mailBildirim } });
      }
      return { previous };
    },
    onError: (_err, _value, context) => {
      if (context?.previous !== undefined) client.setQueryData(queryKeys.ben, context.previous);
    },
    onSuccess: (kullanici) => {
      client.setQueryData<BenYaniti>(queryKeys.ben, (old) => (old === undefined ? old : { ...old, kullanici }));
    },
  });
}
