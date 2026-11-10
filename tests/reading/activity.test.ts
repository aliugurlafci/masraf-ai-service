import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ExtractionError, type Extraction, type ExtractHooks, type ExtractInvoice } from '../../src/claude/extractor.ts';
import type { InvoiceStorage } from '../../src/invoice/storage.ts';
import { createActivityLog, type LiveEvent } from '../../src/reading/activity.ts';
import { createInvoiceReader } from '../../src/reading/reader.ts';
import { PDF_BYTES, sampleExtraction, sampleOlcum } from '../helpers.ts';
import { createMemoryStorage } from '../memory-storage.ts';

const PDF = { mime: 'application/pdf', ext: 'pdf' } as const;
const pdf = (i: number): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(String(i))]);
const input = (i: number, force = false) => ({ buffer: pdf(i), type: PDF, name: `fatura-${i}.pdf`, force });

describe('activity log', () => {
  let storage: InvoiceStorage;
  let extract: Mock<ExtractInvoice>;

  beforeEach(() => {
    storage = createMemoryStorage();
    extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
  });

  /** Extract calls that report their models and finish only when the test says so. */
  const held = (models: string[]): Array<() => void> => {
    const pending: Array<() => void> = [];
    extract.mockImplementation(
      (_file, hooks?: ExtractHooks) =>
        new Promise<Extraction>((resolve) => {
          for (const m of models) hooks?.onModel?.(m);
          pending.push(() => resolve(sampleExtraction()));
        }),
    );
    return pending;
  };

  it('follows a read from arrival to result and tells every listener', async () => {
    const pending = held(['haiku', 'opus']);
    const log = createActivityLog({ esZamanli: 2 });
    const events: LiveEvent[] = [];
    log.subscribe((e) => events.push(e));
    const read = log.track(createInvoiceReader(extract, storage, 2));

    const result = read(input(1), { kaynak: 'api' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const [reading] = log.snapshot().etkinlikler;
    expect(reading).toMatchObject({ durum: 'okunuyor', model: 'opus', modeller: ['haiku', 'opus'], kaynak: 'api', dosyaAdi: 'fatura-1.pdf' });
    expect(reading?.baslama).toEqual(expect.any(String));
    expect(log.snapshot().istatistik).toMatchObject({ esZamanli: 2, okunuyor: 1, sirada: 0, bitti: 0 });

    pending.shift()?.();
    const { record } = await result;
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[0]?.durum).toBe('bitti'));
    expect(log.snapshot().etkinlikler[0]).toMatchObject({
      kayitId: record.id,
      onbellek: false,
      model: 'claude-sonnet-5-5',
      apiEsdegeriUsd: 0.0312,
      hata: null,
      ozet: { faturaNo: 'ABC2026000000123', saticiUnvan: 'Örnek Yazılım A.Ş.', genelToplam: 1800, paraBirimi: 'TRY', kalemSayisi: 1 },
    });
    expect(events.map((e) => [e.etkinlik.durum, e.etkinlik.model])).toEqual([
      ['sirada', null],
      ['okunuyor', null],
      ['okunuyor', 'haiku'],
      ['okunuyor', 'opus'],
      ['bitti', 'claude-sonnet-5-5'],
    ]);
    expect(events.at(-1)?.istatistik).toMatchObject({ okunuyor: 0, bitti: 1, kayittan: 0, hata: 0, apiEsdegeriUsd: 0.0312 });
  });

  it('keeps the models of each cascade step once the read is done', async () => {
    const step = { ...sampleOlcum(), sorunlar: [], hata: null, kullanildi: false };
    const adimlar = [
      { ...step, model: 'claude-haiku-5-5' },
      { ...step, model: 'claude-opus-5-5', kullanildi: true },
    ].map(({ effort: _effort, ...rest }) => rest);
    extract.mockResolvedValueOnce({ ...sampleExtraction(), olcum: sampleOlcum({ model: 'claude-opus-5-5', adimlar }) });
    const log = createActivityLog({ esZamanli: 1 });
    await log.track(createInvoiceReader(extract, storage, 1))(input(1), { kaynak: 'api' });
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[0]?.modeller).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']));
  });

  it('shows a file answered from the records, at no cost', async () => {
    const log = createActivityLog({ esZamanli: 2 });
    const read = log.track(createInvoiceReader(extract, storage, 2));
    await read(input(1), { kaynak: 'api' });
    await read(input(1), { kaynak: 'panel', etiket: 'abc-1' });
    await vi.waitFor(() => expect(log.snapshot().istatistik.bitti).toBe(2));
    expect(log.snapshot().etkinlikler[0]).toMatchObject({ durum: 'bitti', onbellek: true, apiEsdegeriUsd: null, kaynak: 'panel', etiket: 'abc-1', baslama: null });
    expect(log.snapshot().istatistik).toMatchObject({ kayittan: 1, apiEsdegeriUsd: 0.0312 });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('shows why a read failed, hiding unexpected details', async () => {
    extract.mockRejectedValueOnce(new ExtractionError('claude_limit', 'Claude abonelik kullanım limitine ulaşıldı.'));
    extract.mockRejectedValueOnce(new Error('C:\\gizli\\yol'));
    const log = createActivityLog({ esZamanli: 2 });
    const read = log.track(createInvoiceReader(extract, storage, 2));
    await expect(read(input(1), { kaynak: 'api' })).rejects.toThrow(ExtractionError);
    await expect(read(input(2), { kaynak: 'api' })).rejects.toThrow('gizli');
    await vi.waitFor(() => expect(log.snapshot().istatistik.hata).toBe(2));
    expect(log.snapshot().etkinlikler.map((a) => a.hata)).toEqual([
      { kod: 'sunucu_hatasi', mesaj: 'Beklenmeyen bir hata oluştu.' },
      { kod: 'claude_limit', mesaj: 'Claude abonelik kullanım limitine ulaşıldı.' },
    ]);
  });

  it('records refused files with the reason and where they were in the queue', () => {
    const log = createActivityLog({ esZamanli: 2 });
    log.rejected(
      { kaynak: 'api', dosyaAdi: 'C:\\x\\notlar.txt', boyut: 7, kuyrukId: '20261106-120000-aaaaaaaa', sira: 3 },
      { kod: 'desteklenmeyen_dosya', mesaj: 'PDF değil.' },
    );
    expect(log.snapshot().etkinlikler[0]).toMatchObject({
      dosyaAdi: 'notlar.txt',
      durum: 'hata',
      kuyrukId: '20261106-120000-aaaaaaaa',
      sira: 3,
      hata: { kod: 'desteklenmeyen_dosya', mesaj: 'PDF değil.' },
    });
    expect(log.snapshot().istatistik.hata).toBe(1);
  });

  it('counts files waiting for a free slot', async () => {
    const pending = held(['opus']);
    const log = createActivityLog({ esZamanli: 1 });
    const read = log.track(createInvoiceReader(extract, storage, 1));
    const reads = [1, 2, 3].map((i) => read(input(i), { kaynak: 'api' }));
    await vi.waitFor(() => expect(log.snapshot().istatistik).toMatchObject({ okunuyor: 1, sirada: 2 }));
    expect(log.snapshot().etkinlikler.map((a) => a.durum)).toEqual(['sirada', 'sirada', 'okunuyor']);
    while (pending.length > 0 || log.snapshot().istatistik.bitti < 3) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(reads);
  });

  it('shows the place of each waiting file and clears it once the file starts or ends', async () => {
    const pending = held(['opus']);
    const log = createActivityLog({ esZamanli: 1 });
    const events: LiveEvent[] = [];
    log.subscribe((e) => events.push(e));
    const read = log.track(createInvoiceReader(extract, storage, 1));
    const passed: Array<[number, number]> = [];
    const reads = [
      read(input(1), { kaynak: 'arka_plan', kullanici: { id: 7, adSoyad: 'Ayşe Yılmaz' } }),
      read(input(2), { kaynak: 'api' }, { onPosition: (p) => passed.push([p.kuyrukSirasi, p.onundeki]) }),
      read(input(3), { kaynak: 'panel', etiket: 'p-3' }),
    ];

    await vi.waitFor(() => expect(log.snapshot().istatistik).toMatchObject({ okunuyor: 1, sirada: 2 }));
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[0]?.kuyrukSirasi).toBe(2));
    const place = (a: { dosyaAdi: string; durum: string; kaynak: string; kuyrukSirasi: number | null; onundeki: number | null }) => [
      a.dosyaAdi,
      a.durum,
      a.kaynak,
      a.kuyrukSirasi,
      a.onundeki,
    ];
    expect(log.snapshot().etkinlikler.map(place)).toEqual([
      ['fatura-3.pdf', 'sirada', 'panel', 2, 2],
      ['fatura-2.pdf', 'sirada', 'api', 1, 1],
      ['fatura-1.pdf', 'okunuyor', 'arka_plan', null, null],
    ]);
    // The caller's own hooks still hear the place.
    expect(passed).toEqual([[1, 1]]);
    // A place change is a live event of its own.
    expect(events.some((e) => e.etkinlik.dosyaAdi === 'fatura-2.pdf' && e.etkinlik.durum === 'sirada' && e.etkinlik.kuyrukSirasi === 1)).toBe(true);

    pending.shift()?.();
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[1]?.durum).toBe('okunuyor'));
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[0]).toMatchObject({ durum: 'sirada', kuyrukSirasi: 1, onundeki: 1 }));
    expect(log.snapshot().etkinlikler[1]).toMatchObject({ kuyrukSirasi: null, onundeki: null });
    expect(log.snapshot().etkinlikler[2]).toMatchObject({ durum: 'bitti', kaynak: 'arka_plan', kuyrukSirasi: null, onundeki: null });
    expect(events.filter((e) => e.etkinlik.dosyaAdi === 'fatura-3.pdf').map((e) => [e.etkinlik.kuyrukSirasi, e.etkinlik.onundeki])).toEqual([
      [null, null],
      [2, 2],
      [1, 1],
    ]);

    while (log.snapshot().istatistik.bitti < 3) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(reads);
    expect(log.snapshot().etkinlikler.map((a) => [a.kuyrukSirasi, a.onundeki])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it('clears the place of a file whose read failed', async () => {
    const pending = held(['opus']);
    const log = createActivityLog({ esZamanli: 1 });
    const read = log.track(createInvoiceReader(extract, storage, 1));
    const first = read(input(1), { kaynak: 'arka_plan' });
    const second = read(input(2), { kaynak: 'arka_plan' });
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[0]).toMatchObject({ kuyrukSirasi: 1, onundeki: 1 }));
    extract.mockRejectedValueOnce(new ExtractionError('claude_timeout', 'Claude zamanında yanıt vermedi.'));
    pending.shift()?.();
    await first;
    await expect(second).rejects.toThrow(ExtractionError);
    await vi.waitFor(() => expect(log.snapshot().etkinlikler[0]?.durum).toBe('hata'));
    expect(log.snapshot().etkinlikler[0]).toMatchObject({ kaynak: 'arka_plan', kuyrukSirasi: null, onundeki: null });
  });

  it('never shows more files being read than there are slots', async () => {
    const pending = held(['opus']);
    const log = createActivityLog({ esZamanli: 1 });
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.istatistik.okunuyor));
    const read = log.track(createInvoiceReader(extract, storage, 1));
    const reads = [1, 2, 3].map((i) => read(input(i), { kaynak: 'api' }));
    while (log.snapshot().istatistik.bitti < 3) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(reads);
    expect(Math.max(...seen)).toBe(1);
  });

  it('forgets the oldest finished activities but never an unfinished one', async () => {
    const pending = held(['opus']);
    const log = createActivityLog({ esZamanli: 1, keep: 2 });
    const read = log.track(createInvoiceReader(extract, storage, 1));
    const running = read(input(1), { kaynak: 'api' });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) log.rejected({ kaynak: 'api', dosyaAdi: name, boyut: 1 }, { kod: 'x', mesaj: 'y' });

    expect(log.snapshot().etkinlikler.map((a) => a.dosyaAdi)).toEqual(['c.txt', 'b.txt', 'fatura-1.pdf']);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    await running;
  });

  it('keeps reading when a listener throws, and stops calling a listener that unsubscribed', async () => {
    const log = createActivityLog({ esZamanli: 1 });
    log.subscribe(() => {
      throw new Error('kapanmış akış');
    });
    const quiet = vi.fn();
    log.subscribe(quiet)();
    await expect(log.track(createInvoiceReader(extract, storage, 1))(input(1), { kaynak: 'api' })).resolves.toBeDefined();
    expect(quiet).not.toHaveBeenCalled();
  });
});
