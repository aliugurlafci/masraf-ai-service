import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ExtractionError, type Extraction, type ExtractHooks, type ExtractInvoice } from '../../src/claude/extractor.ts';
import type { InvoiceStorage } from '../../src/invoice/storage.ts';
import { createInvoiceReader, type QueuePlace, type ReadHooks } from '../../src/reading/reader.ts';
import { PDF_BYTES, sampleExtraction } from '../helpers.ts';
import { createMemoryStorage } from '../memory-storage.ts';

const PDF = { mime: 'application/pdf', ext: 'pdf' } as const;
const pdf = (i: number): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(String(i))]);
const input = (i: number) => ({ buffer: pdf(i), type: PDF, name: `fatura-${i}.pdf`, force: false });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('invoice reader', () => {
  /** A storage whose lookups answer after the given delays, one per call, so later files can overtake. */
  const slowLookups = (delays: number[], base: InvoiceStorage = createMemoryStorage()): InvoiceStorage => {
    let call = 0;
    return {
      ...base,
      async findByHash(hash) {
        await tick(delays[call++] ?? 0);
        return base.findByHash(hash);
      },
    };
  };

  it('queues files for Claude in the order they arrived, however fast each lookup answers', async () => {
    const order: string[] = [];
    const extract = vi.fn<ExtractInvoice>(async ({ buffer }) => {
      order.push(buffer.subarray(PDF_BYTES.length).toString());
      return sampleExtraction();
    });
    // One slot: the order Claude sees is the queue order. The first lookup is the slowest.
    const read = createInvoiceReader(extract, slowLookups([60, 30, 0]), 1);
    await Promise.all([read(input(1)), read(input(2)), read(input(3))]);
    expect(order).toEqual(['1', '2', '3']);
  });

  it('answers a stored file at once, without waiting for slower lookups ahead of it', async () => {
    const storage = createMemoryStorage();
    const extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    await createInvoiceReader(extract, storage, 1)(input(2)); // file 2 is now stored
    extract.mockClear();

    const read = createInvoiceReader(extract, slowLookups([80, 0], storage), 1);
    const first = read(input(1));
    const started = Date.now();
    const stored = await read(input(2));
    expect(stored.reused).toBe(true);
    expect(Date.now() - started).toBeLessThan(60);
    await first;
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue moving when a lookup fails', async () => {
    const base = createMemoryStorage();
    let call = 0;
    const storage: InvoiceStorage = {
      ...base,
      async findByHash(hash) {
        if (call++ === 0) {
          await tick(20);
          throw new Error('veritabanı yok');
        }
        return base.findByHash(hash);
      },
    };
    const extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    const read = createInvoiceReader(extract, storage, 1);
    const [a, b] = await Promise.allSettled([read(input(1)), read(input(2))]);
    expect(a.status).toBe('rejected');
    expect(b).toMatchObject({ status: 'fulfilled', value: { reused: false } });
  });
});

describe('invoice reader queue places', () => {
  const sha = (i: number): string => createHash('sha256').update(pdf(i)).digest('hex');

  /** Extract calls that finish only when the test says so. */
  const heldExtract = (): { extract: Mock<ExtractInvoice>; pending: Array<() => void> } => {
    const pending: Array<() => void> = [];
    const extract = vi.fn<ExtractInvoice>(() => new Promise<Extraction>((resolve) => pending.push(() => resolve(sampleExtraction()))));
    return { extract, pending };
  };

  /** Records each file's hooks: positions, starts and queue joins. */
  const recorder = () => {
    const positions: Record<number, QueuePlace[]> = {};
    const starts: number[] = [];
    const queued: number[] = [];
    const hooks = (i: number): ReadHooks => {
      positions[i] ??= [];
      return {
        onQueued: () => queued.push(i),
        onPosition: (place) => positions[i]?.push(place),
        onStart: () => starts.push(i),
      };
    };
    return { positions, starts, queued, hooks };
  };

  /** Releases held Claude runs until every read has settled. */
  const drain = async (pending: Array<() => void>, reads: Array<Promise<unknown>>): Promise<void> => {
    let done = false;
    const all = Promise.allSettled(reads).then(() => (done = true));
    while (!done) {
      pending.shift()?.();
      await tick(2);
    }
    await all;
  };

  it('gives every waiting file its place and moves it up as earlier files start', async () => {
    const { extract, pending } = heldExtract();
    const read = createInvoiceReader(extract, createMemoryStorage(), 1);
    const r = recorder();
    const reads = [1, 2, 3].map((i) => read(input(i), r.hooks(i)));

    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // File 1 started at once and was never placed; file 2 waits behind the one being read.
    expect(r.positions).toEqual({
      1: [],
      2: [{ kuyrukSirasi: 1, onundeki: 1 }],
      3: [{ kuyrukSirasi: 2, onundeki: 2 }],
    });
    expect(r.starts).toEqual([1]);
    expect(r.queued).toEqual([1, 2, 3]);

    pending.shift()?.();
    await vi.waitFor(() => expect(r.starts).toEqual([1, 2]));
    expect(r.positions).toEqual({
      1: [],
      2: [{ kuyrukSirasi: 1, onundeki: 1 }],
      3: [
        { kuyrukSirasi: 2, onundeki: 2 },
        { kuyrukSirasi: 1, onundeki: 1 },
      ],
    });

    pending.shift()?.();
    await vi.waitFor(() => expect(r.starts).toEqual([1, 2, 3]));
    // No place changes once a file has started.
    expect(r.positions[3]).toHaveLength(2);
    await drain(pending, reads);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('counts every file being read in onundeki', async () => {
    const { extract, pending } = heldExtract();
    const read = createInvoiceReader(extract, createMemoryStorage(), 2);
    const r = recorder();
    const reads = [1, 2, 3, 4].map((i) => read(input(i), r.hooks(i)));

    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(r.positions).toEqual({
      1: [],
      2: [],
      3: [{ kuyrukSirasi: 1, onundeki: 2 }],
      4: [{ kuyrukSirasi: 2, onundeki: 3 }],
    });

    pending.shift()?.();
    await vi.waitFor(() => expect(r.starts).toEqual([1, 2, 3]));
    expect(r.positions[4]).toEqual([
      { kuyrukSirasi: 2, onundeki: 3 },
      { kuyrukSirasi: 1, onundeki: 2 },
    ]);
    await drain(pending, reads);
  });

  it('does not queue or place a file answered from the stored records', async () => {
    const storage = createMemoryStorage();
    const { extract, pending } = heldExtract();
    const reader = createInvoiceReader(extract, storage, 1);
    const first = reader(input(1));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    await first;

    const r = recorder();
    const again = await reader(input(1), r.hooks(1));
    expect(again.reused).toBe(true);
    expect(r).toMatchObject({ positions: { 1: [] }, starts: [], queued: [] });
    expect(reader.status(sha(1))).toBeNull();
  });

  it('reports where a running read stands, and nothing once it ends', async () => {
    const { extract, pending } = heldExtract();
    const reader = createInvoiceReader(extract, createMemoryStorage(), 1);
    expect(reader.status(sha(1))).toBeNull();

    const reads = [reader(input(1)), reader(input(2))];
    // Still looking in the stored records: waiting, place not known yet.
    expect(reader.status(sha(2))).toEqual({ durum: 'sirada', place: null });

    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(reader.status(sha(1))).toEqual({ durum: 'okunuyor', place: null });
    expect(reader.status(sha(2))).toEqual({ durum: 'sirada', place: { kuyrukSirasi: 1, onundeki: 1 } });

    pending.shift()?.();
    await vi.waitFor(() => expect(reader.status(sha(2))).toEqual({ durum: 'okunuyor', place: null }));
    await vi.waitFor(() => expect(reader.status(sha(1))).toBeNull());

    pending.shift()?.();
    await Promise.all(reads);
    expect(reader.status(sha(2))).toBeNull();
    expect(reader.status(sha(3))).toBeNull();
  });

  it('forgets the status of a read that failed', async () => {
    const extract = vi.fn<ExtractInvoice>(async () => {
      throw new ExtractionError('claude_failed', 'Claude faturayı okuyamadı.');
    });
    const reader = createInvoiceReader(extract, createMemoryStorage(), 1);
    await expect(reader(input(1))).rejects.toThrow(ExtractionError);
    expect(reader.status(sha(1))).toBeNull();
  });

  it('hands the running file only to a user who sent or joined it', async () => {
    const { extract, pending } = heldExtract();
    const reader = createInvoiceReader(extract, createMemoryStorage(), 1);
    const own = reader({ ...input(1), kullaniciId: 7 });
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    expect(reader.file(sha(1), 7)).toEqual({ buffer: pdf(1), type: PDF, name: 'fatura-1.pdf' });
    expect(reader.file(sha(1), 8)).toBeNull();
    expect(reader.file(sha(2), 7)).toBeNull();

    // A joiner becomes a caller; a read without a user does not add anyone.
    const joined = reader({ ...input(1), name: 'kopya.pdf', kullaniciId: 8 });
    const anonymous = reader(input(1));
    expect(reader.file(sha(1), 8)).toEqual({ buffer: pdf(1), type: PDF, name: 'fatura-1.pdf' });
    expect(reader.file(sha(1), 9)).toBeNull();

    pending.shift()?.();
    await Promise.all([own, joined, anonymous]);
    expect(reader.file(sha(1), 7)).toBeNull();
    expect(reader.file(sha(1), 8)).toBeNull();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('lets a file that is waiting be joined, with the same status and place', async () => {
    const { extract, pending } = heldExtract();
    const reader = createInvoiceReader(extract, createMemoryStorage(), 1);
    const r = recorder();
    const first = reader(input(1));
    const waiting = reader({ ...input(2), kullaniciId: 7 }, r.hooks(2));
    await vi.waitFor(() => expect(r.positions[2]).toHaveLength(1));
    const before = reader.status(sha(2));
    expect(before).toEqual({ durum: 'sirada', place: { kuyrukSirasi: 1, onundeki: 1 } });

    const joiner = recorder();
    const joined = reader({ ...input(2), kullaniciId: 8 }, joiner.hooks(2));
    // The joiner catches up at once with what the shared read went through.
    expect(joiner).toMatchObject({ queued: [2], positions: { 2: [{ kuyrukSirasi: 1, onundeki: 1 }] }, starts: [] });
    expect(reader.status(sha(2))).toEqual(before);
    expect(reader.file(sha(2), 8)).not.toBeNull();

    pending.shift()?.();
    await vi.waitFor(() => expect(joiner.starts).toEqual([2]));
    expect(r.starts).toEqual([2]);
    pending.shift()?.();
    const [, own, shared] = await Promise.all([first, waiting, joined]);
    expect(own.reused).toBe(false);
    expect(shared).toEqual({ record: own.record, reused: true });
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('brings a joiner of a file being read up to date, model included', async () => {
    const pending: Array<() => void> = [];
    const extract = vi.fn<ExtractInvoice>(
      (_file, hooks?: ExtractHooks) =>
        new Promise<Extraction>((resolve) => {
          hooks?.onModel?.('haiku');
          pending.push(() => resolve(sampleExtraction()));
        }),
    );
    const reader = createInvoiceReader(extract, createMemoryStorage(), 1);
    const first = reader(input(1));
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const events: string[] = [];
    const joined = reader(input(1), {
      onQueued: () => events.push('queued'),
      onPosition: () => events.push('position'),
      onStart: () => events.push('start'),
      onModel: (m) => events.push(`model:${m}`),
    });
    expect(events).toEqual(['queued', 'start', 'model:haiku']);
    pending.shift()?.();
    await Promise.all([first, joined]);
  });
});
