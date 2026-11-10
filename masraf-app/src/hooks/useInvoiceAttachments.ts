import { useEffect, useRef, useState } from 'react';

import { ApiError, errorMessage } from '@/api/client';
import { getQueue, uploadInvoice, type PickedFile } from '@/api/endpoints';
import type { BekleyenFatura, Kuyruk, MasrafDetay, MasrafFatura, OkunanFatura } from '@/api/types';
import { config } from '@/config';
import type { InvoiceSummary } from '@/lib/invoices';

/** Where a file picked on this device stands. `startedAt` is when it was added (shown as elapsed time). */
export type LocalReading =
  /** Waiting on the device for a free upload slot (see MAX_UPLOADS). */
  | { readonly phase: 'pending'; readonly startedAt: number }
  | { readonly phase: 'uploading'; readonly startedAt: number }
  | {
      readonly phase: 'waiting';
      readonly startedAt: number;
      readonly queueId: string;
      /** sirada: waiting for a free reader; okunuyor: Claude is reading it now. */
      readonly itemState: 'sirada' | 'okunuyor';
      /** The file's SHA-256: a draft saved now carries it in `bekleyenFaturalar`. */
      readonly dosyaOzeti: string | null;
      /** Place in the shared reading queue while sirada (1 = next); null when not known. */
      readonly kuyrukSirasi: number | null;
      /** Files read before this one, including those being read now. */
      readonly onundeki: number | null;
    }
  | {
      readonly phase: 'done';
      readonly kayitId: string;
      readonly sonuc: OkunanFatura | null;
      /** The same file was read before; the stored result came back at once. */
      readonly onbellek: boolean;
      /** The file's SHA-256, matched against the saved form's invoices and pending files. */
      readonly dosyaOzeti: string | null;
    }
  | { readonly phase: 'failed'; readonly kod: string; readonly message: string };

/**
 * One invoice on the form: already on the server (edit mode), a file the server reads in the background
 * for this saved form (`pending`, edit mode) or a file picked and read on this device.
 */
export type InvoiceAttachment =
  | { readonly key: string; readonly kind: 'server'; readonly fatura: MasrafFatura }
  | { readonly key: string; readonly kind: 'pending'; readonly bekleyen: BekleyenFatura }
  | { readonly key: string; readonly kind: 'local'; readonly file: PickedFile; readonly reading: LocalReading };

const serverItem = (fatura: MasrafFatura): InvoiceAttachment => ({ key: `s-${fatura.id}`, kind: 'server', fatura });
const pendingItem = (bekleyen: BekleyenFatura): InvoiceAttachment => ({ key: `p-${bekleyen.dosyaOzeti}`, kind: 'pending', bekleyen });

/** The invoice id to send in `faturaIdler`, or null while the file is not read (yet). */
export function attachmentId(item: InvoiceAttachment): string | null {
  if (item.kind === 'server') return item.fatura.id;
  if (item.kind === 'pending') return null;
  return item.reading.phase === 'done' ? item.reading.kayitId : null;
}

/**
 * The file's SHA-256 to send in `bekleyenFaturalar`: a pending invoice of the saved form (failed ones
 * too; the server keeps them as they are) or a file on this device the server is still reading. Null for
 * anything else.
 */
export function pendingHash(item: InvoiceAttachment): string | null {
  if (item.kind === 'pending') return item.bekleyen.dosyaOzeti;
  if (item.kind === 'local' && item.reading.phase === 'waiting') return item.reading.dosyaOzeti;
  return null;
}

/**
 * The SHA-256 of the item's file, whatever its state: an invoice's `dosyaOzeti` (null for old records), a
 * pending file's, or a picked file's once the server answered. Matches a pending file to the invoice it
 * became. Null while not known.
 */
export function fileHash(item: InvoiceAttachment): string | null {
  if (item.kind === 'server') return item.fatura.dosyaOzeti;
  if (item.kind === 'pending') return item.bekleyen.dosyaOzeti;
  return item.reading.phase === 'waiting' || item.reading.phase === 'done' ? item.reading.dosyaOzeti : null;
}

/** `bekleyenFaturalar` for the list: every pending file once, in list order. */
export function pendingHashes(list: readonly InvoiceAttachment[]): string[] {
  return Array.from(new Set(list.flatMap((item) => pendingHash(item) ?? [])));
}

/** What was read from the invoice, or null when nothing is known (yet). */
export function attachmentSummary(item: InvoiceAttachment): InvoiceSummary | null {
  if (item.kind === 'server') return item.fatura;
  if (item.kind === 'pending') return null;
  return item.reading.phase === 'done' ? (item.reading.sonuc?.fatura ?? null) : null;
}

/** Still being uploaded or read, on this device or in the server's background reading. */
export const isReading = (item: InvoiceAttachment): boolean =>
  item.kind === 'pending'
    ? item.bekleyen.durum !== 'hata'
    : item.kind === 'local' && (item.reading.phase === 'pending' || item.reading.phase === 'uploading' || item.reading.phase === 'waiting');

/** Not on the server yet: a draft cannot carry it, not even as a pending invoice, until the upload ends. */
export const isUploading = (item: InvoiceAttachment): boolean =>
  item.kind === 'local' &&
  (item.reading.phase === 'pending' || item.reading.phase === 'uploading' || (item.reading.phase === 'waiting' && item.reading.dosyaOzeti === null));

/** A file on this device that could not be read; it is left out when the form is saved. */
export const isFailed = (item: InvoiceAttachment): boolean => item.kind === 'local' && item.reading.phase === 'failed';

/** A pending invoice of the saved form the server could not read; it stays on the form until read again or removed. */
export const isPendingFailed = (item: InvoiceAttachment): boolean => item.kind === 'pending' && item.bekleyen.durum === 'hata';

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
 * Uploads in flight at once. iOS opens at most 4 connections per host (Android 5) and every request of
 * the app shares them; more uploads would leave the status polls and the other screens waiting behind
 * them, running out their timeouts in the queue. The rest wait on the device and start as slots free up.
 */
const MAX_UPLOADS = 2;

interface Run {
  readonly id: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the server started reading the file (`okunuyor`); time spent queued there does not count. */
  readingSince: number | null;
}

/**
 * The form's invoice list, in the order they were added. Each picked file is uploaded on its own through
 * the multi-file endpoint (at most MAX_UPLOADS at a time) and its queue is polled every
 * EXPO_PUBLIC_OKUMA_SORGU_ARALIGI_MS until the file is `bitti` or `hata`; the server decides how many are
 * read in parallel. EXPO_PUBLIC_OKUMA_UST_SURE_MS counts from the moment the server starts reading the
 * file. Polling of an item stops when it is removed, retried or the form unmounts; the server keeps reading
 * in the background regardless. Nothing new starts after unmount.
 *
 * A saved form's pending invoices (`bekleyenFaturalar`) come after its invoices; their reading is followed
 * through the form itself (see sync).
 */
export function useInvoiceAttachments(initial: readonly MasrafFatura[], initialPending: readonly BekleyenFatura[], events: AttachmentEvents) {
  const [items, setItems] = useState<readonly InvoiceAttachment[]>(() => [...initial.map(serverItem), ...initialPending.map(pendingItem)]);
  // Every change goes through update(), so this is always the latest list, also inside async callbacks.
  const itemsRef = useRef(items);
  // Invoice ids of the saved form seen so far, and the files removed on this screen: a later copy of the
  // form brings neither back, also not a removed pending file that the server has read into an invoice.
  const seenIds = useRef(new Set(initial.map((f) => f.id)));
  const droppedHashes = useRef(new Set<string>());
  // Each reading run gets its own id; timers and responses of a stopped run are ignored.
  const runs = useRef(new Map<string, Run>());
  // Keys waiting for an upload slot, oldest first, and the number of uploads in flight.
  const waiting = useRef<string[]>([]);
  const uploads = useRef(0);
  const counter = useRef(0);
  const mounted = useRef(false);
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  });

  useEffect(() => {
    mounted.current = true;
    const active = runs.current;
    const queued = waiting.current;
    return () => {
      mounted.current = false;
      for (const run of active.values()) if (run.timer !== null) clearTimeout(run.timer);
      active.clear();
      queued.length = 0;
    };
  }, []);

  const update = (change: (list: readonly InvoiceAttachment[]) => readonly InvoiceAttachment[]): readonly InvoiceAttachment[] => {
    const next = change(itemsRef.current);
    itemsRef.current = next;
    if (mounted.current) setItems(next);
    return next;
  };

  const stop = (key: string): void => {
    const run = runs.current.get(key);
    if (run !== undefined && run.timer !== null) clearTimeout(run.timer);
    runs.current.delete(key);
    const at = waiting.current.indexOf(key);
    if (at >= 0) waiting.current.splice(at, 1);
  };

  const alive = (key: string, id: number): boolean => mounted.current && runs.current.get(key)?.id === id;

  const setReading = (key: string, reading: LocalReading): void => {
    update((list) => list.map((item) => (item.key === key && item.kind === 'local' ? { ...item, reading } : item)));
  };

  const fail = (key: string, id: number, file: PickedFile, kod: string, message: string): void => {
    if (!alive(key, id)) return;
    stop(key);
    setReading(key, { phase: 'failed', kod, message });
    eventsRef.current.onFailed(file);
  };

  /**
   * Whether another item of the list already holds this file: the same record id (the server rejects a
   * repeat) or the same file (an invoice or pending file of the saved form, or a file picked twice).
   */
  const heldElsewhere = (key: string, kayitId: string | null, hash: string | null): boolean =>
    itemsRef.current.some(
      (item) => item.key !== key && ((kayitId !== null && attachmentId(item) === kayitId) || (hash !== null && fileHash(item) === hash)),
    );

  /** Takes a picked file that turned out to be on the list already off it again. */
  const dropDuplicate = (key: string, file: PickedFile): void => {
    stop(key);
    update((list) => list.filter((item) => item.key !== key));
    eventsRef.current.onDuplicate(file);
  };

  const finish = (key: string, id: number, file: PickedFile, done: Extract<LocalReading, { phase: 'done' }>): void => {
    if (!alive(key, id)) return;
    if (heldElsewhere(key, done.kayitId, done.dosyaOzeti)) {
      dropDuplicate(key, file);
      return;
    }
    stop(key);
    const list = update((current) => current.map((item) => (item.key === key && item.kind === 'local' ? { ...item, reading: done } : item)));
    eventsRef.current.onRead(key, list);
  };

  const settle = (key: string, id: number, file: PickedFile, startedAt: number, queue: Kuyruk): void => {
    if (!alive(key, id)) return;
    const run = runs.current.get(key);
    const entry = queue.dosyalar[0];
    if (run === undefined) return;
    if (entry === undefined) {
      fail(key, id, file, 'dosya_yok', 'Sunucu dosyayı kuyrukta göstermedi.');
      return;
    }
    if (entry.durum === 'bitti' && entry.kayitId !== null) {
      finish(key, id, file, { phase: 'done', kayitId: entry.kayitId, sonuc: entry.sonuc, onbellek: entry.onbellek, dosyaOzeti: entry.dosyaOzeti });
      return;
    }
    if (entry.durum === 'hata' || entry.durum === 'bitti') {
      fail(key, id, file, entry.hata?.kod ?? 'okunamadi', entry.hata?.mesaj ?? 'Fatura okunamadı.');
      return;
    }
    // The file is on the list already (an invoice or pending file of the saved form, or picked twice): no
    // need to wait for its reading to find out.
    if (heldElsewhere(key, null, entry.dosyaOzeti)) {
      dropDuplicate(key, file);
      return;
    }
    if (entry.durum === 'okunuyor' && run.readingSince === null) run.readingSince = Date.now();
    if (run.readingSince !== null && Date.now() - run.readingSince > config.readingMaxMs) {
      fail(key, id, file, 'okuma_zaman_asimi', 'Okuma beklenenden uzun sürdü.');
      return;
    }
    setReading(key, {
      phase: 'waiting',
      startedAt,
      queueId: queue.id,
      itemState: entry.durum,
      dosyaOzeti: entry.dosyaOzeti,
      kuyrukSirasi: entry.kuyrukSirasi,
      onundeki: entry.onundeki,
    });
    schedule(key, id, file, startedAt, queue.id, 0);
  };

  const schedule = (key: string, id: number, file: PickedFile, startedAt: number, queueId: string, pollErrors: number): void => {
    const run = runs.current.get(key);
    if (!alive(key, id) || run === undefined) return;
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

  /** Starts uploads while slots are free, oldest waiting file first. */
  const pump = (): void => {
    while (mounted.current && uploads.current < MAX_UPLOADS && waiting.current.length > 0) {
      const key = waiting.current.shift() as string;
      const run = runs.current.get(key);
      const item = itemsRef.current.find((i) => i.key === key);
      if (run === undefined || item === undefined || item.kind !== 'local') continue;
      const id = run.id;
      const file = item.file;
      const startedAt = item.reading.phase === 'pending' ? item.reading.startedAt : Date.now();
      uploads.current += 1;
      setReading(key, { phase: 'uploading', startedAt });
      uploadInvoice(file)
        .then(
          (queue) => settle(key, id, file, startedAt, queue),
          (err: unknown) => fail(key, id, file, err instanceof ApiError ? err.kod : 'hata', errorMessage(err)),
        )
        .finally(() => {
          // The slot frees when the request ends, even for a file removed meanwhile.
          uploads.current -= 1;
          pump();
        });
    }
  };

  const read = (key: string): void => {
    if (!mounted.current) return;
    stop(key);
    counter.current += 1;
    runs.current.set(key, { id: counter.current, timer: null, readingSince: null });
    setReading(key, { phase: 'pending', startedAt: Date.now() });
    waiting.current.push(key);
    pump();
  };

  /** Adds a picked file at the end of the list and starts reading it. Does nothing after unmount. */
  const add = (file: PickedFile): void => {
    if (!mounted.current) return;
    counter.current += 1;
    const key = `l-${counter.current}`;
    update((list) => [...list, { key, kind: 'local', file, reading: { phase: 'pending', startedAt: Date.now() } }]);
    read(key);
  };

  /** Reads a failed file again, in the same place on the list. */
  const retry = (key: string): void => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item?.kind === 'local') read(key);
  };

  /** Takes an invoice off the list (cancels its reading); returns the new list. */
  const remove = (key: string): readonly InvoiceAttachment[] => {
    stop(key);
    const removed = itemsRef.current.find((item) => item.key === key);
    const hash = removed === undefined ? null : fileHash(removed);
    if (hash !== null) droppedHashes.current.add(hash);
    return update((list) => list.filter((item) => item.key !== key));
  };

  /**
   * Brings the list up to a newer copy of the saved form, without undoing what the user changed here:
   * pending invoices take their new state; one the server no longer lists is gone (read and added to the
   * invoices, or found to be on the form already). Invoices the server added meanwhile (a pending file that
   * was read) come at the end as ordinary invoices, in the server's order. An invoice read from a file the
   * user removed here, or from a file another item already holds, is not shown (matched by `dosyaOzeti`).
   * Returns the new list, the invoices that arrived on it, and the ids of every invoice the server added
   * (shown or not), in the server's order: a save measures the list against those.
   */
  const sync = (
    detail: MasrafDetay,
  ): { readonly list: readonly InvoiceAttachment[]; readonly arrived: readonly { key: string; id: string }[]; readonly newIds: readonly string[] } => {
    const pendingNow = new Map(detail.bekleyenFaturalar.map((b) => [b.dosyaOzeti, b] as const));
    const arrived: { key: string; id: string }[] = [];
    const newIds: string[] = [];
    const list = update((current) => {
      const kept = current.flatMap((item): InvoiceAttachment[] => {
        if (item.kind !== 'pending') return [item];
        const next = pendingNow.get(item.bekleyen.dosyaOzeti);
        return next === undefined ? [] : [{ ...item, bekleyen: next }];
      });
      const onScreenIds = new Set(kept.flatMap((item) => attachmentId(item) ?? []));
      const onScreenHashes = new Set(kept.flatMap((item) => fileHash(item) ?? []));
      const added: InvoiceAttachment[] = [];
      for (const fatura of detail.faturalar) {
        if (seenIds.current.has(fatura.id)) continue;
        newIds.push(fatura.id);
        if (onScreenIds.has(fatura.id)) continue;
        const hash = fatura.dosyaOzeti;
        if (hash !== null && (droppedHashes.current.has(hash) || onScreenHashes.has(hash))) continue;
        const item = serverItem(fatura);
        added.push(item);
        arrived.push({ key: item.key, id: fatura.id });
      }
      for (const bekleyen of detail.bekleyenFaturalar) {
        if (onScreenHashes.has(bekleyen.dosyaOzeti) || droppedHashes.current.has(bekleyen.dosyaOzeti)) continue;
        added.push(pendingItem(bekleyen));
      }
      return added.length === 0 ? kept : [...kept, ...added];
    });
    for (const fatura of detail.faturalar) seenIds.current.add(fatura.id);
    return { list, arrived, newIds };
  };

  return {
    items,
    add,
    retry,
    remove,
    sync,
    /** Some file is still being uploaded or read (here or in the server's background reading). */
    reading: items.some(isReading),
    /** Some file has not reached the server yet; nothing can be saved until it does. */
    uploading: items.some(isUploading),
  };
}
