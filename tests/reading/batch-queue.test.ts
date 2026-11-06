import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createBatchQueue, toItemError, type BatchInput } from '../../src/reading/batch-queue.ts';
import { ExtractionError, type Extraction, type ExtractInvoice } from '../../src/claude/extractor.ts';
import { createInvoiceReader } from '../../src/reading/reader.ts';
import type { InvoiceStorage } from '../../src/invoice/storage.ts';
import { PDF_BYTES, sampleExtraction, sampleInvoice } from '../helpers.ts';
import { createMemoryStorage } from '../memory-storage.ts';

const PDF = { mime: 'application/pdf', ext: 'pdf' } as const;
const pdf = (i: number): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(String(i))]);
const input = (i: number): BatchInput => ({ name: `fatura-${i}.pdf`, buffer: pdf(i), type: PDF });

describe('batch queue', () => {
  let storage: InvoiceStorage;
  let extract: Mock<ExtractInvoice>;

  beforeEach(() => {
    storage = createMemoryStorage();
    extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
  });

  /** Extract calls that finish only when the test says so. */
  const held = (): Array<() => void> => {
    const pending: Array<() => void> = [];
    extract.mockImplementation(() => new Promise<Extraction>((resolve) => pending.push(() => resolve(sampleExtraction()))));
    return pending;
  };

  it('reads every file, at most esZamanli at a time, in upload order', async () => {
    const pending = held();
    const queue = createBatchQueue(createInvoiceReader(extract, storage, 2), { esZamanli: 2 });
    // Answers while Claude is still reading: add() never waits for a Claude run.
    const batch = await queue.add([1, 2, 3, 4, 5].map(input), false);

    expect(batch.esZamanli).toBe(2);
    expect(batch.sayac).toEqual({ toplam: 5, sirada: 3, okunuyor: 2, bitti: 0, hata: 0 });
    await vi.waitFor(() => expect(queue.get(batch.id)?.sayac.okunuyor).toBe(2));
    expect(queue.get(batch.id)?.dosyalar.map((d) => d.durum)).toEqual(['okunuyor', 'okunuyor', 'sirada', 'sirada', 'sirada']);

    pending.shift()?.();
    await vi.waitFor(() => expect(queue.get(batch.id)?.dosyalar[2]?.durum).toBe('okunuyor'));
    expect(queue.get(batch.id)?.dosyalar[0]).toMatchObject({ durum: 'bitti', kayitId: expect.any(String), onbellek: false });
    expect(queue.get(batch.id)?.sayac.okunuyor).toBe(2);

    while (queue.get(batch.id)?.bitti !== true) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(queue.get(batch.id)?.sayac).toEqual({ toplam: 5, sirada: 0, okunuyor: 0, bitti: 5, hata: 0 });
    expect(extract).toHaveBeenCalledTimes(5);
    expect(await storage.list()).toHaveLength(5);
  });

  it('returns files read before at once, without waiting for a slot', async () => {
    const reader = createInvoiceReader(extract, storage, 1);
    const first = await reader({ buffer: pdf(1), type: PDF, name: 'eski.pdf', force: false });
    const pending = held();
    const queue = createBatchQueue(reader, { esZamanli: 1 });

    const batch = await queue.add([input(2), input(1)], false);
    expect(batch.dosyalar).toEqual([
      expect.objectContaining({ sira: 1, durum: 'okunuyor', sonuc: null }),
      expect.objectContaining({ sira: 2, durum: 'bitti', onbellek: true, kayitId: first.record.id, sonuc: sampleInvoice() }),
    ]);
    pending.shift()?.();
    await vi.waitFor(() => expect(queue.get(batch.id)?.bitti).toBe(true));
  });

  it('reads again when forced', async () => {
    const reader = createInvoiceReader(extract, storage, 2);
    await reader({ buffer: pdf(1), type: PDF, name: 'a.pdf', force: false });
    const queue = createBatchQueue(reader, { esZamanli: 2 });
    const batch = await queue.add([input(1)], true);
    await vi.waitFor(() => expect(queue.get(batch.id)?.bitti).toBe(true));
    expect(queue.get(batch.id)?.dosyalar[0]?.onbellek).toBe(false);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('keeps going when a file fails, and reports why', async () => {
    extract.mockRejectedValueOnce(new ExtractionError('claude_timeout', 'Claude zamanında yanıt vermedi.'));
    const onError = vi.fn();
    const onResult = vi.fn();
    const queue = createBatchQueue(createInvoiceReader(extract, storage, 1), { esZamanli: 1, onError, onResult });
    const batch = await queue.add([input(1), { name: 'not.txt', hata: { kod: 'desteklenmeyen_dosya', mesaj: 'PDF değil.' } }, input(2)], false);

    expect(batch.dosyalar[1]).toMatchObject({ durum: 'hata', hata: { kod: 'desteklenmeyen_dosya', mesaj: 'PDF değil.' } });
    await vi.waitFor(() => expect(queue.get(batch.id)?.bitti).toBe(true));
    expect(queue.get(batch.id)?.dosyalar.map((d) => d.durum)).toEqual(['hata', 'hata', 'bitti']);
    expect(queue.get(batch.id)?.dosyalar[0]?.hata).toEqual({ kod: 'claude_timeout', mesaj: 'Claude zamanında yanıt vermedi.' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('reads a file listed twice once', async () => {
    const pending = held();
    const queue = createBatchQueue(createInvoiceReader(extract, storage, 2), { esZamanli: 2 });
    const batch = await queue.add([input(1), { ...input(1), name: 'kopya.pdf' }], false);
    expect(batch.dosyalar.map((d) => d.durum)).toEqual(['okunuyor', 'okunuyor']);

    pending.shift()?.();
    await vi.waitFor(() => expect(queue.get(batch.id)?.bitti).toBe(true));
    const [a, b] = queue.get(batch.id)?.dosyalar ?? [];
    expect(a).toMatchObject({ durum: 'bitti', onbellek: false, sonuc: sampleInvoice() });
    expect(b).toMatchObject({ durum: 'bitti', onbellek: true, kayitId: a?.kayitId, sonuc: sampleInvoice() });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('answers at once for a file that another upload is already reading', async () => {
    const pending = held();
    const reader = createInvoiceReader(extract, storage, 1);
    const queue = createBatchQueue(reader, { esZamanli: 1 });
    const single = reader({ buffer: pdf(1), type: PDF, name: 'tek.pdf', force: false });
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const batch = await queue.add([input(1)], false);
    expect(batch.dosyalar[0]?.durum).toBe('okunuyor');
    pending.shift()?.();
    const { record } = await single;
    await vi.waitFor(() => expect(queue.get(batch.id)?.dosyalar[0]).toMatchObject({ durum: 'bitti', kayitId: record.id }));
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('hides the details of unexpected errors', () => {
    expect(toItemError(new Error('C:\\gizli\\yol'))).toEqual({ kod: 'sunucu_hatasi', mesaj: 'Beklenmeyen bir hata oluştu.' });
  });

  it('cleans file names', async () => {
    const queue = createBatchQueue(createInvoiceReader(extract, storage, 1), { esZamanli: 1 });
    const batch = await queue.add([{ name: 'C:\\klasör\\ekim\u0007.pdf', hata: { kod: 'x', mesaj: 'y' } }], false);
    expect(batch.dosyalar[0]?.dosyaAdi).toBe('ekim.pdf');
  });

  it('forgets the oldest finished batches but never an unfinished one', async () => {
    const pending = held();
    const queue = createBatchQueue(createInvoiceReader(extract, storage, 1), { esZamanli: 1, keep: 2 });
    const running = await queue.add([input(1)], false);
    const done = await Promise.all([1, 2, 3].map(() => queue.add([{ name: 'x.txt', hata: { kod: 'x', mesaj: 'y' } }], false)));

    expect(queue.get(running.id)).not.toBeNull();
    expect(queue.get(done[0]?.id ?? '')).toBeNull();
    expect(queue.get(done[1]?.id ?? '')).not.toBeNull();
    expect(queue.get(done[2]?.id ?? '')).not.toBeNull();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    await vi.waitFor(() => expect(queue.get(running.id)?.bitti).toBe(true));
  });

  it('returns null for an unknown batch', () => {
    expect(createBatchQueue(createInvoiceReader(extract, storage, 1), { esZamanli: 1 }).get('20261106-000000-deadbeef')).toBeNull();
  });
});
