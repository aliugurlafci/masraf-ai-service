import { describe, expect, it, vi } from 'vitest';
import type { ExtractInvoice } from '../../src/claude/extractor.ts';
import type { InvoiceStorage } from '../../src/invoice/storage.ts';
import { createInvoiceReader } from '../../src/reading/reader.ts';
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
