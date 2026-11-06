import { createHash } from 'node:crypto';
import type { ExtractInvoice } from './claude-extractor.ts';
import type { DetectedFile } from './file-type.ts';
import type { InvoiceStorage, StoredRecord } from './storage.ts';

export interface ReadInput {
  readonly buffer: Buffer;
  readonly type: DetectedFile;
  readonly name: string;
  /** Read again with Claude even if this exact file was read before. */
  readonly force: boolean;
}

export interface ReadResult {
  readonly record: StoredRecord;
  /** True when no new Claude run was made for this request. */
  readonly reused: boolean;
}

export type ReadInvoice = (input: ReadInput) => Promise<ReadResult>;

/**
 * Wraps the Claude extraction with two savings:
 * - a file that was already read returns the stored result (no Claude run);
 * - the same file uploaded again while it is being read joins the running read.
 */
export function createInvoiceReader(extract: ExtractInvoice, storage: InvoiceStorage): ReadInvoice {
  const running = new Map<string, Promise<ReadResult>>();

  return async ({ buffer, type, name, force }) => {
    const hash = createHash('sha256').update(buffer).digest('hex');

    const joined = running.get(hash);
    if (joined !== undefined) return { record: (await joined).record, reused: true };

    const job = (async (): Promise<ReadResult> => {
      if (!force) {
        const existing = await storage.findByHash(hash);
        if (existing !== null) return { record: existing, reused: true };
      }
      const { sonuc, olcum } = await extract({ buffer, type });
      return { record: await storage.save({ dosyaAdi: name, sonuc, dosyaOzeti: hash, olcum }), reused: false };
    })();

    running.set(hash, job);
    try {
      return await job;
    } finally {
      running.delete(hash);
    }
  };
}
