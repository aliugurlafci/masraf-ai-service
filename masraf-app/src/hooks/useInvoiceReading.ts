import { useEffect, useRef, useState } from 'react';

import { ApiError, errorMessage } from '@/api/client';
import { getQueue, uploadInvoice, type PickedFile } from '@/api/endpoints';
import type { Kuyruk, KuyrukDosyasi, OkunanFatura } from '@/api/types';
import { config } from '@/config';

export type ReadingState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'uploading'; readonly file: PickedFile; readonly startedAt: number }
  | {
      readonly phase: 'waiting';
      readonly file: PickedFile;
      readonly startedAt: number;
      readonly queueId: string;
      /** sirada: waiting for a free reader; okunuyor: Claude is reading it now. */
      readonly itemState: 'sirada' | 'okunuyor';
    }
  | {
      readonly phase: 'done';
      readonly file: PickedFile;
      readonly kayitId: string;
      readonly sonuc: OkunanFatura | null;
      /** The same file was read before; the stored result came back at once. */
      readonly onbellek: boolean;
    }
  | { readonly phase: 'failed'; readonly file: PickedFile; readonly kod: string; readonly message: string };

/** Consecutive polling failures tolerated (e.g. a short network drop) before giving up. */
const MAX_POLL_ERRORS = 3;

/**
 * Reads one invoice through the multi-file endpoint: uploads it, then polls the queue every
 * EXPO_PUBLIC_OKUMA_SORGU_ARALIGI_MS until the file is `bitti` or `hata`. Polling stops on reset,
 * on a new file and on unmount; the server keeps reading in the background regardless.
 */
export function useInvoiceReading() {
  const [state, setState] = useState<ReadingState>({ phase: 'idle' });
  // Each start() gets a new run id; stale timers and responses of an older run are ignored.
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = (): void => {
    run.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => stop, []);

  const settle = (id: number, file: PickedFile, startedAt: number, queue: Kuyruk, pollErrors: number): void => {
    if (id !== run.current) return;
    const item: KuyrukDosyasi | undefined = queue.dosyalar[0];
    if (item === undefined) {
      setState({ phase: 'failed', file, kod: 'dosya_yok', message: 'Sunucu dosyayı kuyrukta göstermedi. Formu elle doldurabilirsiniz.' });
      return;
    }
    if (item.durum === 'bitti' && item.kayitId !== null) {
      setState({ phase: 'done', file, kayitId: item.kayitId, sonuc: item.sonuc, onbellek: item.onbellek });
      return;
    }
    if (item.durum === 'hata' || item.durum === 'bitti') {
      setState({
        phase: 'failed',
        file,
        kod: item.hata?.kod ?? 'okunamadi',
        message: item.hata?.mesaj ?? 'Fatura okunamadı. Formu elle doldurabilirsiniz.',
      });
      return;
    }
    if (Date.now() - startedAt > config.readingMaxMs) {
      setState({
        phase: 'failed',
        file,
        kod: 'okuma_zaman_asimi',
        message: 'Okuma beklenenden uzun sürdü. Formu elle doldurabilir ya da daha sonra tekrar deneyebilirsiniz.',
      });
      return;
    }
    setState({ phase: 'waiting', file, startedAt, queueId: queue.id, itemState: item.durum });
    schedule(id, file, startedAt, queue.id, pollErrors);
  };

  const schedule = (id: number, file: PickedFile, startedAt: number, queueId: string, pollErrors: number): void => {
    timer.current = setTimeout(() => {
      getQueue(queueId).then(
        (queue) => settle(id, file, startedAt, queue, 0),
        (err: unknown) => {
          if (id !== run.current) return;
          const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
          if (transient && pollErrors + 1 < MAX_POLL_ERRORS) {
            schedule(id, file, startedAt, queueId, pollErrors + 1);
            return;
          }
          setState({ phase: 'failed', file, kod: err instanceof ApiError ? err.kod : 'hata', message: errorMessage(err) });
        },
      );
    }, config.pollIntervalMs);
  };

  const start = (file: PickedFile): void => {
    stop();
    const id = run.current;
    const startedAt = Date.now();
    setState({ phase: 'uploading', file, startedAt });
    uploadInvoice(file).then(
      (queue) => settle(id, file, startedAt, queue, 0),
      (err: unknown) => {
        if (id !== run.current) return;
        setState({ phase: 'failed', file, kod: err instanceof ApiError ? err.kod : 'hata', message: errorMessage(err) });
      },
    );
  };

  const reset = (): void => {
    stop();
    setState({ phase: 'idle' });
  };

  const busy = state.phase === 'uploading' || state.phase === 'waiting';
  return { state, start, reset, busy };
}
