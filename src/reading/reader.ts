import { createHash } from 'node:crypto';
import { createSemaphore, type ExtractInvoice } from '../claude/extractor.ts';
import type { DetectedFile } from '../invoice/file-type.ts';
import type { InvoiceStorage, StoredRecord } from '../invoice/storage.ts';

export interface ReadInput {
  readonly buffer: Buffer;
  readonly type: DetectedFile;
  readonly name: string;
  /** Read again with Claude even if this exact file was read before. */
  readonly force: boolean;
  /** Who sent the file; stored as the uploader when Claude reads it. */
  readonly kullaniciId?: number | null;
}

/** Where a file waiting for Claude stands in the shared queue. */
export interface QueuePlace {
  /** Its place among the files waiting for a free reader; 1 = next. */
  readonly kuyrukSirasi: number;
  /** Files read before it: those being read now plus those waiting ahead of it. */
  readonly onundeki: number;
}

export interface ReadHooks {
  /** Called when the file needs a Claude run (no stored result) and has joined the queue, before it waits for a free slot. */
  readonly onQueued?: () => void;
  /** Called when the file's place in the queue is known and each time it changes, until Claude starts on it. */
  readonly onPosition?: (place: QueuePlace) => void;
  /** Called when Claude starts on this file, after it waited for a free slot. */
  readonly onStart?: () => void;
  /** Called each time a model starts reading the file (twice when the cascade moves to the next model). */
  readonly onModel?: (model: string) => void;
}

export interface ReadResult {
  readonly record: StoredRecord;
  /** True when no new Claude run was made for this request. */
  readonly reused: boolean;
}

/** A running read as others see it: waiting (with its place once known) or being read. */
export type ReadingStatus =
  | { readonly durum: 'sirada'; readonly place: QueuePlace | null }
  | { readonly durum: 'okunuyor'; readonly place: null };

/** A file of a running read, for a caller that sent it. */
export interface RunningFile {
  readonly buffer: Buffer;
  readonly type: DetectedFile;
  readonly name: string;
}

export type ReadInvoice = (input: ReadInput, hooks?: ReadHooks) => Promise<ReadResult>;

export interface InvoiceReader extends ReadInvoice {
  /** Where the read of the file with this SHA-256 stands; null when no read of it is running. */
  status(hash: string): ReadingStatus | null;
  /** The file of a running read with this SHA-256 that `kullaniciId` sent (or joined); null otherwise. */
  file(hash: string, kullaniciId: number): RunningFile | null;
}

interface Progress {
  /** lookup: checking the stored records; waiting: needs Claude, waits for a slot; reading: Claude runs. */
  phase: 'lookup' | 'waiting' | 'reading';
  /** Place in the queue while waiting, once it is placed. */
  place: QueuePlace | null;
  /** Model reading the file right now. */
  model: string | null;
  /** Hooks of every caller that shares this read. */
  readonly hooks: ReadHooks[];
  /** The file and everyone who asked for it, so a caller can hand it on (e.g. to a saved form). */
  readonly file: RunningFile;
  readonly callers: Set<number>;
}

interface Job {
  readonly progress: Progress;
  readonly result: Promise<ReadResult>;
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/**
 * Wraps the Claude extraction with a queue and two savings:
 * - at most `maxConcurrent` files are read by Claude at once; the rest wait in order;
 * - a file that was already read returns the stored result at once, without waiting for a slot;
 * - the same file uploaded again while it is being read joins the running read.
 * Every waiting file knows its place in the queue (QueuePlace).
 */
export function createInvoiceReader(extract: ExtractInvoice, storage: InvoiceStorage, maxConcurrent: number): InvoiceReader {
  const running = new Map<string, Job>();
  const limit = createSemaphore(maxConcurrent);
  // Files join the Claude queue in the order they arrived. Lookups run in parallel and finish in any
  // order, so each file waits for the earlier ones to be placed (queued or answered) before it queues.
  let placed: Promise<void> = Promise.resolve();
  // Files placed in the semaphore and not started yet, in the semaphore's (first come, first served) order.
  const waiting: Progress[] = [];
  let reading = 0;

  /** Tells every waiting file whose place changed where it stands now. */
  const announce = (): void => {
    waiting.forEach((progress, i) => {
      const place: QueuePlace = { kuyrukSirasi: i + 1, onundeki: reading + i };
      if (progress.place?.kuyrukSirasi === place.kuyrukSirasi && progress.place.onundeki === place.onundeki) return;
      progress.place = place;
      for (const h of progress.hooks) h.onPosition?.(place);
    });
  };

  const read = async ({ buffer, type, name, force, kullaniciId }: ReadInput, hooks: ReadHooks = {}): Promise<ReadResult> => {
    const hash = sha256(buffer);

    const joined = running.get(hash);
    if (joined !== undefined) {
      const { progress } = joined;
      progress.hooks.push(hooks);
      if (kullaniciId !== undefined && kullaniciId !== null) progress.callers.add(kullaniciId);
      // Catch up with what the shared read already went through.
      if (progress.phase !== 'lookup') hooks.onQueued?.();
      if (progress.place !== null) hooks.onPosition?.(progress.place);
      if (progress.phase === 'reading') hooks.onStart?.();
      if (progress.model !== null) hooks.onModel?.(progress.model);
      return { record: (await joined.result).record, reused: true };
    }

    const progress: Progress = {
      phase: 'lookup',
      place: null,
      model: null,
      hooks: [hooks],
      file: { buffer, type, name },
      callers: new Set(kullaniciId === undefined || kullaniciId === null ? [] : [kullaniciId]),
    };
    const earlier = placed;
    let markPlaced = (): void => {};
    placed = new Promise<void>((resolve) => (markPlaced = resolve));
    const result = (async (): Promise<ReadResult> => {
      let existing: StoredRecord | null = null;
      try {
        if (!force) existing = await storage.findByHash(hash);
      } catch (err) {
        void earlier.then(markPlaced);
        throw err;
      }
      if (existing !== null) {
        // A stored result answers at once; only the files behind it wait for the earlier ones.
        void earlier.then(markPlaced);
        return { record: existing, reused: true };
      }
      await earlier;
      // Placed: from here on the file has a place in the queue. limit() queues synchronously, so the
      // waiting list has the semaphore's order, and the next file is let through only after this one.
      progress.phase = 'waiting';
      waiting.push(progress);
      for (const h of progress.hooks) h.onQueued?.();
      // The slot is held until the record is saved, so the live monitor never sees the next file
      // start while this one still shows as being read.
      const queued = limit(async () => {
        waiting.splice(waiting.indexOf(progress), 1);
        progress.phase = 'reading';
        progress.place = null;
        reading += 1;
        announce();
        for (const h of progress.hooks) h.onStart?.();
        try {
          const { sonuc, olcum } = await extract(
            { buffer, type },
            {
              onModel: (model) => {
                progress.model = model;
                for (const h of progress.hooks) h.onModel?.(model);
              },
            },
          );
          return await storage.save({ dosyaAdi: name, sonuc, dosyaOzeti: hash, olcum, dosya: { icerik: buffer, mime: type.mime }, yukleyenId: kullaniciId ?? null });
        } finally {
          reading -= 1;
        }
      });
      announce();
      markPlaced();
      return { record: await queued, reused: false };
    })();
    running.set(hash, { progress, result });
    try {
      return await result;
    } finally {
      running.delete(hash);
    }
  };

  return Object.assign(read, {
    status(hash: string): ReadingStatus | null {
      const job = running.get(hash);
      if (job === undefined) return null;
      const { phase, place } = job.progress;
      return phase === 'reading' ? { durum: 'okunuyor', place: null } : { durum: 'sirada', place };
    },
    file(hash: string, kullaniciId: number): RunningFile | null {
      const job = running.get(hash);
      return job !== undefined && job.progress.callers.has(kullaniciId) ? job.progress.file : null;
    },
  });
}
