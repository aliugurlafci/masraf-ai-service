import { useEffect, useRef, useState } from 'react';

import { ApiError, errorMessage } from '@/api/client';
import { getQueue, uploadInvoice, type PickedFile } from '@/api/endpoints';
import type { Kuyruk, MasrafFatura, OkunanFatura } from '@/api/types';
import { config } from '@/config';
import type { InvoiceSummary } from '@/lib/invoices';

/** Where a file picked on this device stands in the reading queue. */
export type LocalReading =
  | { readonly phase: 'uploading'; readonly startedAt: number }
  | {
      readonly phase: 'waiting';
      readonly startedAt: number;
      readonly queueId: string;
      /** sirada: waiting for a free reader; okunuyor: Claude is reading it now. */
      readonly itemState: 'sirada' | 'okunuyor';
    }
  | {
      readonly phase: 'done';
      readonly kayitId: string;
      readonly sonuc: OkunanFatura | null;
      /** The same file was read before; the stored result came back at once. */
      readonly onbellek: boolean;
    }
  | { readonly phase: 'failed'; readonly kod: string; readonly message: string };

/** One invoice on the form: already on the server (edit mode) or a file read on this device. */
export type InvoiceAttachment =
  | { readonly key: string; readonly kind: 'server'; readonly fatura: MasrafFatura }
  | { readonly key: string; readonly kind: 'local'; readonly file: PickedFile; readonly reading: LocalReading };

/** The invoice id to send in `faturaIdler`, or null while the file is not read (yet). */
export function attachmentId(item: InvoiceAttachment): string | null {
  if (item.kind === 'server') return item.fatura.id;
  return item.reading.phase === 'done' ? item.reading.kayitId : null;
}

/** What was read from the invoice, or null when nothing is known (yet). */
export function attachmentSummary(item: InvoiceAttachment): InvoiceSummary | null {
  if (item.kind === 'server') return item.fatura;
  return item.reading.phase === 'done' ? (item.reading.sonuc?.fatura ?? null) : null;
}

export const isReading = (item: InvoiceAttachment): boolean =>
  item.kind === 'local' && (item.reading.phase === 'uploading' || item.reading.phase === 'waiting');

export const isFailed = (item: InvoiceAttachment): boolean => item.kind === 'local' && item.reading.phase === 'failed';

export interface AttachmentEvents {
  /** A file finished reading; `list` already holds it in its place. */
  readonly onRead: (key: string, list: readonly InvoiceAttachment[]) => void;
  /** A file turned out to be an invoice already on the form; it was taken off the list again. */
  readonly onDuplicate: (file: PickedFile) => void;
  readonly onFailed: (file: PickedFile) => void;
}

/** Consecutive polling failures tolerated (e.g. a short network drop) before giving up. */
const MAX_POLL_ERRORS = 3;

/**
 * The form's invoice list, in the order they were added. Each picked file is uploaded on its own through
 * the multi-file endpoint and its queue is polled every EXPO_PUBLIC_OKUMA_SORGU_ARALIGI_MS until the file
 * is `bitti` or `hata`; several files can be read at once (the server decides how many run in parallel).
 * Polling of an item stops when it is removed, retried or the form unmounts; the server keeps reading in
 * the background regardless.
 */
export function useInvoiceAttachments(initial: readonly MasrafFatura[], events: AttachmentEvents) {
  const [items, setItems] = useState<readonly InvoiceAttachment[]>(() =>
    initial.map((fatura) => ({ key: `s-${fatura.id}`, kind: 'server', fatura })),
  );
  // Every change goes through update(), so this is always the latest list, also inside async callbacks.
  const itemsRef = useRef(items);
  // Each reading run gets its own id; timers and responses of a stopped run are ignored.
  const runs = useRef(new Map<string, { readonly id: number; timer: ReturnType<typeof setTimeout> | null }>());
  const counter = useRef(0);
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  });

  useEffect(() => {
    const active = runs.current;
    return () => {
      for (const run of active.values()) if (run.timer !== null) clearTimeout(run.timer);
      active.clear();
    };
  }, []);

  const update = (change: (list: readonly InvoiceAttachment[]) => readonly InvoiceAttachment[]): readonly InvoiceAttachment[] => {
    const next = change(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
    return next;
  };

  const stop = (key: string): void => {
    const run = runs.current.get(key);
    if (run !== undefined && run.timer !== null) clearTimeout(run.timer);
    runs.current.delete(key);
  };

  const alive = (key: string, id: number): boolean => runs.current.get(key)?.id === id;

  const setReading = (key: string, reading: LocalReading): void => {
    update((list) => list.map((item) => (item.key === key && item.kind === 'local' ? { ...item, reading } : item)));
  };

  const fail = (key: string, id: number, file: PickedFile, kod: string, message: string): void => {
    if (!alive(key, id)) return;
    stop(key);
    setReading(key, { phase: 'failed', kod, message });
    eventsRef.current.onFailed(file);
  };

  const finish = (key: string, id: number, file: PickedFile, done: Extract<LocalReading, { phase: 'done' }>): void => {
    if (!alive(key, id)) return;
    stop(key);
    // The same file (or a file already on the form) gives the same record id; the server rejects a repeat.
    if (itemsRef.current.some((item) => item.key !== key && attachmentId(item) === done.kayitId)) {
      update((list) => list.filter((item) => item.key !== key));
      eventsRef.current.onDuplicate(file);
      return;
    }
    const list = update((current) => current.map((item) => (item.key === key && item.kind === 'local' ? { ...item, reading: done } : item)));
    eventsRef.current.onRead(key, list);
  };

  const settle = (key: string, id: number, file: PickedFile, startedAt: number, queue: Kuyruk): void => {
    if (!alive(key, id)) return;
    const entry = queue.dosyalar[0];
    if (entry === undefined) {
      fail(key, id, file, 'dosya_yok', 'Sunucu dosyayı kuyrukta göstermedi.');
      return;
    }
    if (entry.durum === 'bitti' && entry.kayitId !== null) {
      finish(key, id, file, { phase: 'done', kayitId: entry.kayitId, sonuc: entry.sonuc, onbellek: entry.onbellek });
      return;
    }
    if (entry.durum === 'hata' || entry.durum === 'bitti') {
      fail(key, id, file, entry.hata?.kod ?? 'okunamadi', entry.hata?.mesaj ?? 'Fatura okunamadı.');
      return;
    }
    if (Date.now() - startedAt > config.readingMaxMs) {
      fail(key, id, file, 'okuma_zaman_asimi', 'Okuma beklenenden uzun sürdü.');
      return;
    }
    setReading(key, { phase: 'waiting', startedAt, queueId: queue.id, itemState: entry.durum });
    schedule(key, id, file, startedAt, queue.id, 0);
  };

  const schedule = (key: string, id: number, file: PickedFile, startedAt: number, queueId: string, pollErrors: number): void => {
    const run = runs.current.get(key);
    if (run === undefined || run.id !== id) return;
    run.timer = setTimeout(() => {
      getQueue(queueId).then(
        (queue) => settle(key, id, file, startedAt, queue),
        (err: unknown) => {
          if (!alive(key, id)) return;
          const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
          if (transient && pollErrors + 1 < MAX_POLL_ERRORS) {
            schedule(key, id, file, startedAt, queueId, pollErrors + 1);
            return;
          }
          fail(key, id, file, err instanceof ApiError ? err.kod : 'hata', errorMessage(err));
        },
      );
    }, config.pollIntervalMs);
  };

  const read = (key: string, file: PickedFile): void => {
    stop(key);
    counter.current += 1;
    const id = counter.current;
    runs.current.set(key, { id, timer: null });
    const startedAt = Date.now();
    setReading(key, { phase: 'uploading', startedAt });
    uploadInvoice(file).then(
      (queue) => settle(key, id, file, startedAt, queue),
      (err: unknown) => fail(key, id, file, err instanceof ApiError ? err.kod : 'hata', errorMessage(err)),
    );
  };

  /** Adds a picked file at the end of the list and starts reading it. */
  const add = (file: PickedFile): void => {
    counter.current += 1;
    const key = `l-${counter.current}`;
    update((list) => [...list, { key, kind: 'local', file, reading: { phase: 'uploading', startedAt: Date.now() } }]);
    read(key, file);
  };

  /** Reads a failed file again, in the same place on the list. */
  const retry = (key: string): void => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item?.kind === 'local') read(key, item.file);
  };

  /** Takes an invoice off the list (cancels its reading); returns the new list. */
  const remove = (key: string): readonly InvoiceAttachment[] => {
    stop(key);
    return update((list) => list.filter((item) => item.key !== key));
  };

  return { items, add, retry, remove, busy: items.some(isReading) };
}
