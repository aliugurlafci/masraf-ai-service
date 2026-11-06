import { ExtractionError } from '../claude/extractor.ts';
import type { DetectedFile } from '../invoice/file-type.ts';
import type { ReadHooks, ReadInput, ReadResult } from './reader.ts';
import type { Invoice } from '../invoice/schema.ts';
import { cleanFileName, newRecordId } from '../invoice/storage.ts';

export type ItemState = 'sirada' | 'okunuyor' | 'bitti' | 'hata';

export interface ItemError {
  readonly kod: string;
  readonly mesaj: string;
}

/** A file to read, or one the server already refused (wrong type, too large) with the reason. */
export type BatchInput =
  | { readonly name: string; readonly buffer: Buffer; readonly type: DetectedFile }
  | { readonly name: string; readonly hata: ItemError; readonly size?: number };

export interface BatchItemView {
  readonly sira: number;
  readonly dosyaAdi: string;
  readonly durum: ItemState;
  /** Record id once read; GET /api/invoices/<kayitId> returns the invoice. */
  readonly kayitId: string | null;
  /** True when the stored result of an identical file was returned (no Claude run). */
  readonly onbellek: boolean;
  readonly hata: ItemError | null;
  /** The invoice once read: {fatura, kalemler}. Measurements are on GET /api/invoices/<kayitId>. */
  readonly sonuc: Invoice | null;
}

export interface BatchView {
  readonly id: string;
  readonly olusturulma: string;
  /** True when every file is read or failed. */
  readonly bitti: boolean;
  /** How many files Claude reads at the same time (shared with single uploads). */
  readonly esZamanli: number;
  readonly sayac: Readonly<Record<ItemState | 'toplam', number>>;
  readonly dosyalar: readonly BatchItemView[];
}

/** Where a file sits: its queue, its position and whatever the caller passed to add() (e.g. who sent it). */
export interface BatchPlace<C> {
  readonly kuyrukId: string;
  readonly sira: number;
  readonly context: C | undefined;
}

export type BatchRead<C> = (input: ReadInput, hooks: ReadHooks, place: BatchPlace<C>) => Promise<ReadResult>;

export interface BatchQueue<C> {
  /**
   * Queues the files and returns once each one is either done (read before, or refused) or waiting for
   * Claude. It never waits for a Claude run; those go on in the background.
   */
  add(inputs: readonly BatchInput[], force: boolean, context?: C): Promise<BatchView>;
  get(id: string): BatchView | null;
  /** What the caller passed to add() for this batch (e.g. who sent it); undefined for unknown ids. */
  contextOf(id: string): C | undefined;
}

export interface BatchQueueOptions<C> {
  readonly esZamanli: number;
  /** Finished batches kept for status queries; unfinished ones are never dropped. */
  readonly keep?: number;
  readonly onResult?: (result: ReadResult) => void;
  readonly onError?: (err: unknown) => void;
  /** Called for a file refused before reading (wrong type, too large). */
  readonly onRejected?: (file: { readonly name: string; readonly size: number; readonly hata: ItemError }, place: BatchPlace<C>) => void;
  readonly now?: () => Date;
}

interface Item {
  readonly sira: number;
  readonly dosyaAdi: string;
  durum: ItemState;
  kayitId: string | null;
  onbellek: boolean;
  hata: ItemError | null;
  sonuc: Invoice | null;
}

interface Batch<C> {
  readonly id: string;
  readonly context: C | undefined;
  readonly olusturulma: string;
  readonly items: Item[];
}

/** ExtractionError messages are Turkish and safe to show; anything else may hold internals. */
export function toItemError(err: unknown): ItemError {
  if (err instanceof ExtractionError) return { kod: err.code, mesaj: err.message };
  return { kod: 'sunucu_hatasi', mesaj: 'Beklenmeyen bir hata oluştu.' };
}

const finished = (b: Batch<unknown>): boolean => b.items.every((i) => i.durum === 'bitti' || i.durum === 'hata');

/**
 * Keeps track of multi-file uploads. Every file goes through the same reader as a single upload, so the
 * reader's limit decides how many are read at once; this module only records each file's progress.
 * Batches live in memory: a server restart forgets the queue (finished invoices are already saved).
 */
export function createBatchQueue<C = undefined>(read: BatchRead<C>, opts: BatchQueueOptions<C>): BatchQueue<C> {
  const batches = new Map<string, Batch<C>>();
  const keep = opts.keep ?? 20;
  const now = opts.now ?? (() => new Date());

  const view = (b: Batch<C>): BatchView => {
    const sayac = { toplam: b.items.length, sirada: 0, okunuyor: 0, bitti: 0, hata: 0 };
    for (const i of b.items) sayac[i.durum]++;
    return {
      id: b.id,
      olusturulma: b.olusturulma,
      bitti: finished(b),
      esZamanli: opts.esZamanli,
      sayac,
      dosyalar: b.items.map((i) => ({ ...i })),
    };
  };

  const prune = (): void => {
    const done = [...batches.values()].filter(finished);
    for (const b of done.slice(0, Math.max(0, done.length - keep))) batches.delete(b.id);
  };

  return {
    async add(inputs, force, context) {
      const at = now();
      const batch: Batch<C> = { id: newRecordId(at), olusturulma: at.toISOString(), context, items: [] };
      // Resolves per file once it is clear whether the answer is already known or Claude has to read it.
      const settled: Array<Promise<void>> = [];
      inputs.forEach((input, index) => {
        const item: Item = {
          sira: index + 1,
          dosyaAdi: cleanFileName(input.name),
          durum: 'sirada',
          kayitId: null,
          onbellek: false,
          hata: null,
          sonuc: null,
        };
        batch.items.push(item);
        const place: BatchPlace<C> = { kuyrukId: batch.id, sira: item.sira, context };
        if ('hata' in input) {
          item.durum = 'hata';
          item.hata = input.hata;
          opts.onRejected?.({ name: input.name, size: input.size ?? 0, hata: input.hata }, place);
          return;
        }
        let settle = (): void => {};
        settled.push(new Promise<void>((resolve) => (settle = resolve)));
        const hooks = { onQueued: () => settle(), onStart: () => (item.durum = 'okunuyor') };
        read({ buffer: input.buffer, type: input.type, name: input.name, force }, hooks, place).then(
          (result) => {
            item.durum = 'bitti';
            item.kayitId = result.record.id;
            item.onbellek = result.reused;
            item.sonuc = result.record.sonuc;
            settle();
            opts.onResult?.(result);
          },
          (err: unknown) => {
            item.durum = 'hata';
            item.hata = toItemError(err);
            settle();
            opts.onError?.(err);
          },
        );
      });
      batches.set(batch.id, batch);
      prune();
      await Promise.all(settled);
      return view(batch);
    },

    get(id) {
      const batch = batches.get(id);
      return batch === undefined ? null : view(batch);
    },

    contextOf(id) {
      return batches.get(id)?.context;
    },
  };
}
