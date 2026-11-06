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

export interface ReadHooks {
  /** Called when the file needs a Claude run (no stored result), before it waits for a free slot. */
  readonly onQueued?: () => void;
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

export type ReadInvoice = (input: ReadInput, hooks?: ReadHooks) => Promise<ReadResult>;

interface Progress {
  /** lookup: checking the stored records; waiting: needs Claude, waits for a slot; reading: Claude runs. */
  phase: 'lookup' | 'waiting' | 'reading';
  /** Model reading the file right now. */
  model: string | null;
  /** Hooks of every caller that shares this read. */
  readonly hooks: ReadHooks[];
}

interface Job {
  readonly progress: Progress;
  readonly result: Promise<ReadResult>;
}

/**
 * Wraps the Claude extraction with a queue and two savings:
 * - at most `maxConcurrent` files are read by Claude at once; the rest wait in order;
 * - a file that was already read returns the stored result at once, without waiting for a slot;
 * - the same file uploaded again while it is being read joins the running read.
 */
export function createInvoiceReader(extract: ExtractInvoice, storage: InvoiceStorage, maxConcurrent: number): ReadInvoice {
  const running = new Map<string, Job>();
  const limit = createSemaphore(maxConcurrent);
  // Files join the Claude queue in the order they arrived. Lookups run in parallel and finish in any
  // order, so each file waits for the earlier ones to be placed (queued or answered) before it queues.
  let placed: Promise<void> = Promise.resolve();

  return async ({ buffer, type, name, force, kullaniciId }, hooks = {}) => {
    const hash = createHash('sha256').update(buffer).digest('hex');

    const joined = running.get(hash);
    if (joined !== undefined) {
      const { progress } = joined;
      progress.hooks.push(hooks);
      // Catch up with what the shared read already went through.
      if (progress.phase !== 'lookup') hooks.onQueued?.();
      if (progress.phase === 'reading') hooks.onStart?.();
      if (progress.model !== null) hooks.onModel?.(progress.model);
      return { record: (await joined.result).record, reused: true };
    }

    const progress: Progress = { phase: 'lookup', model: null, hooks: [hooks] };
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
      progress.phase = 'waiting';
      for (const h of progress.hooks) h.onQueued?.();
      await earlier;
      // The slot is held until the record is saved, so the live monitor never sees the next file
      // start while this one still shows as being read. limit() queues synchronously, so the order
      // is fixed before the next file is let through.
      const queued = limit(async () => {
        progress.phase = 'reading';
        for (const h of progress.hooks) h.onStart?.();
        const { sonuc, olcum } = await extract(
          { buffer, type },
          {
            onModel: (model) => {
              progress.model = model;
              for (const h of progress.hooks) h.onModel?.(model);
            },
          },
        );
        return storage.save({ dosyaAdi: name, sonuc, dosyaOzeti: hash, olcum, dosya: { icerik: buffer, mime: type.mime }, yukleyenId: kullaniciId ?? null });
      });
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
}
