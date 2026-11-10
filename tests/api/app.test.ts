import { createHash } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/app.ts';
import type { LiveEvent, LiveSnapshot } from '../../src/reading/activity.ts';
import type { BatchView } from '../../src/reading/batch-queue.ts';
import { ExtractionError, type Extraction, type ExtractInvoice } from '../../src/claude/extractor.ts';
import { execute, queryOne, type Db } from '../../src/db/sql.ts';
import { createInvoiceStorage, type InvoiceStorage } from '../../src/invoice/storage.ts';
import { PDF_BYTES, PNG_BYTES, sampleExtraction, sampleInvoice, sampleOlcum } from '../helpers.ts';
import { closeTestDb, makeUser, resetDb, testDb, tokenFor } from '../db.ts';

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe('HTTP API', () => {
  let db: Db;
  let token: string;
  let server: Server;
  let base: string;
  let port: number;
  let storage: InvoiceStorage;
  let extract: Mock<ExtractInvoice>;

  // Every call in this file is made by a signed-in administrator. Signing in, roles and what an
  // employee may see are tested in tests/api/auth.test.ts and tests/api/expenses.test.ts.
  const fetch = (input: string, init: RequestInit = {}): Promise<Response> =>
    globalThis.fetch(input, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) } });

  const start = async (
    maxFileBytes = 1024 * 1024,
    log: (line: string) => void = () => {},
    extra: Pick<AppDeps, 'maxConcurrent' | 'maxBatchFiles' | 'maxBatchBytes' | 'liveHeartbeatMs' | 'lanHosts'> = {},
  ): Promise<void> => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    server.on('request', createApp({ extract, db, storage, maxFileBytes, port, log, ...extra }));
  };

  const restart = async (...args: Parameters<typeof start>): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(...args);
  };

  /** node:http lets the test send arbitrary Host and Origin headers. */
  const raw = (path: string, headers: Record<string, string>, method = 'GET', body?: Buffer): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });

  const upload = (buf: Buffer, name = 'fatura.pdf'): Promise<Response> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)]), name);
    return fetch(`${base}/api/invoices`, { method: 'POST', body: form });
  };

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);

  beforeEach(async () => {
    await resetDb(db);
    storage = createInvoiceStorage(db);
    token = await tokenFor(db, (await makeUser(db, { rol: 'yonetici', adSoyad: 'Test Yönetici' })).id);
    extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    await start();
  });

  afterEach(async () => {
    server.closeAllConnections(); // live streams stay open until closed
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ durum: 'ok' });
  });

  it('reads a multipart upload, returns fatura + kalemler + olcum and stores the record', async () => {
    const res = await upload(PDF_BYTES, 'Ekim.pdf');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ...sampleInvoice(),
      olcum: { kaynak: 'claude', istekSuresiMs: expect.any(Number), okuma: sampleOlcum() },
    });

    const id = res.headers.get('x-fatura-id') ?? '';
    expect(res.headers.get('location')).toBe(`/api/invoices/${id}`);
    expect(extract).toHaveBeenCalledWith({ buffer: PDF_BYTES, type: { mime: 'application/pdf', ext: 'pdf' } }, { onModel: expect.any(Function) });

    const list = (await (await fetch(`${base}/api/invoices`)).json()) as Array<{ id: string; dosyaAdi: string }>;
    expect(list).toEqual([expect.objectContaining({ id, dosyaAdi: 'Ekim.pdf', faturaNo: 'ABC2026000000123' })]);
    const one = await fetch(`${base}/api/invoices/${id}`);
    expect(await one.json()).toEqual({
      ...sampleInvoice(),
      olcum: { kaynak: 'kayit', istekSuresiMs: expect.any(Number), okuma: sampleOlcum() },
    });
  });

  it('logs which models read the file and why the cascade moved on', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const log = vi.fn();
    await start(undefined, log);
    const step = { ...sampleOlcum(), hata: null };
    const adimlar = [
      { ...step, model: 'claude-haiku-5-5', sorunlar: ['Kalemlerin toplamı ara toplamı tutmuyor.'], kullanildi: false },
      { ...step, model: 'claude-opus-5-5', sorunlar: [], kullanildi: true },
    ].map(({ effort: _effort, ...rest }) => rest);
    extract.mockResolvedValueOnce({ sonuc: sampleInvoice(), olcum: sampleOlcum({ model: 'claude-opus-5-5', adimlar }) });

    const res = await upload(PDF_BYTES);
    expect(((await res.json()) as { olcum: { okuma: { adimlar: unknown[] } } }).olcum.okuma.adimlar).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('kademe=claude-haiku-5-5>claude-opus-5-5 neden="Kalemlerin toplamı ara toplamı tutmuyor."'),
    );
  });

  it('returns okuma: null for records saved before measuring', async () => {
    const old = await storage.save({ dosyaAdi: 'eski.pdf', sonuc: sampleInvoice() });
    const res = await fetch(`${base}/api/invoices/${old.id}`);
    expect(((await res.json()) as { olcum: unknown }).olcum).toEqual({
      kaynak: 'kayit',
      istekSuresiMs: expect.any(Number),
      okuma: null,
    });
  });

  it('accepts the raw file as the body with X-File-Name', async () => {
    const res = await fetch(`${base}/api/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('şubat faturası.png') },
      body: PNG_BYTES,
    });
    expect(res.status).toBe(201);
    expect(extract).toHaveBeenCalledWith({ buffer: PNG_BYTES, type: { mime: 'image/png', ext: 'png' } }, { onModel: expect.any(Function) });
    expect((await storage.list())[0]?.dosyaAdi).toBe('şubat faturası.png');
  });

  describe('repeated files', () => {
    it('returns the stored result for the same file without running Claude again', async () => {
      const first = await upload(PDF_BYTES, 'ilk.pdf');
      expect(first.status).toBe(201);
      expect(first.headers.get('x-fatura-onbellek')).toBeNull();

      const again = await upload(PDF_BYTES, 'tekrar.pdf');
      expect(again.status).toBe(200);
      expect(again.headers.get('x-fatura-onbellek')).toBe('1');
      expect(again.headers.get('x-fatura-id')).toBe(first.headers.get('x-fatura-id'));
      // The measurements belong to the first (and only) Claude run.
      expect(await again.json()).toEqual({
        ...sampleInvoice(),
        olcum: { kaynak: 'kayit', istekSuresiMs: expect.any(Number), okuma: sampleOlcum() },
      });
      expect(extract).toHaveBeenCalledTimes(1);
      expect(await storage.list()).toHaveLength(1);
    });

    it('reads again when ?yenile=1 is given', async () => {
      const first = await upload(PDF_BYTES);
      const res = await fetch(`${base}/api/invoices?yenile=1`, {
        method: 'POST',
        headers: { 'X-File-Name': 'a.pdf' },
        body: PDF_BYTES,
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('x-fatura-id')).not.toBe(first.headers.get('x-fatura-id'));
      expect(extract).toHaveBeenCalledTimes(2);
    });

    it('joins a read of the same file that is still running', async () => {
      let finish: (() => void) | undefined;
      extract.mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve(sampleExtraction()))),
      );
      const a = upload(PDF_BYTES);
      await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
      const b = upload(PDF_BYTES);
      await new Promise((r) => setTimeout(r, 50));
      finish?.();
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.status, rb.status].sort()).toEqual([200, 201]);
      expect(ra.headers.get('x-fatura-id')).toBe(rb.headers.get('x-fatura-id'));
      expect(extract).toHaveBeenCalledTimes(1);
    });

    it('does not remember failed reads', async () => {
      extract.mockRejectedValueOnce(new ExtractionError('claude_timeout', 'yavaş'));
      expect((await upload(PDF_BYTES)).status).toBe(504);
      expect((await upload(PDF_BYTES)).status).toBe(201);
      expect(extract).toHaveBeenCalledTimes(2);
    });

    it('treats different files separately', async () => {
      expect((await upload(PDF_BYTES)).status).toBe(201);
      expect((await upload(PNG_BYTES, 'b.png')).status).toBe(201);
      expect(extract).toHaveBeenCalledTimes(2);
    });
  });

  describe('multi-file upload', () => {
    const pdf = (i: number): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(String(i))]);

    const uploadMany = (files: Array<[Buffer, string]>, query = '', field = 'files'): Promise<Response> => {
      const form = new FormData();
      for (const [buf, name] of files) form.append(field, new Blob([new Uint8Array(buf)]), name);
      return fetch(`${base}/api/invoices/toplu${query}`, { method: 'POST', body: form });
    };

    const status = async (id: string): Promise<BatchView> =>
      (await (await fetch(`${base}/api/invoices/toplu/${id}`)).json()) as BatchView;

    const untilDone = async (id: string): Promise<BatchView> => {
      let view = await status(id);
      await vi.waitFor(async () => {
        view = await status(id);
        expect(view.bitti).toBe(true);
      });
      return view;
    };

    it('queues the files, answers 202 at once and reads them in the background', async () => {
      const res = await uploadMany([
        [pdf(1), 'ekim.pdf'],
        [pdf(2), 'kasım.pdf'],
        [PNG_BYTES, 'fiş.png'],
      ]);
      expect(res.status).toBe(202);
      const batch = (await res.json()) as BatchView;
      expect(res.headers.get('location')).toBe(`/api/invoices/toplu/${batch.id}`);
      expect(batch).toMatchObject({ bitti: false, esZamanli: 2, sayac: { toplam: 3, hata: 0 } });
      expect(batch.dosyalar.map((d) => d.dosyaAdi)).toEqual(['ekim.pdf', 'kasım.pdf', 'fiş.png']);

      const done = await untilDone(batch.id);
      expect(done.sayac).toEqual({ toplam: 3, sirada: 0, okunuyor: 0, bitti: 3, hata: 0 });
      expect(extract).toHaveBeenCalledTimes(3);
      // Each finished file points at its record.
      const first = await fetch(`${base}/api/invoices/${done.dosyalar[0]?.kayitId ?? ''}`);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject(sampleInvoice());
    });

    it('never runs more than maxConcurrent reads, single uploads included', async () => {
      await restart(undefined, undefined, { maxConcurrent: 2 });
      let active = 0;
      let peak = 0;
      extract.mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
        return sampleExtraction();
      });
      const res = await uploadMany([1, 2, 3, 4, 5].map((i): [Buffer, string] => [pdf(i), `${i}.pdf`]));
      const single = upload(pdf(6), 'tek.pdf');
      await untilDone(((await res.json()) as BatchView).id);
      expect((await single).status).toBe(201);
      expect(extract).toHaveBeenCalledTimes(6);
      expect(peak).toBe(2);
    });

    it('shows which files are waiting and which are being read', async () => {
      await restart(undefined, undefined, { maxConcurrent: 1 });
      const pending: Array<() => void> = [];
      extract.mockImplementation(() => new Promise<Extraction>((resolve) => pending.push(() => resolve(sampleExtraction()))));
      const { id } = (await (await uploadMany([[pdf(1), 'a.pdf'], [pdf(2), 'b.pdf']])).json()) as BatchView;

      await vi.waitFor(async () => expect((await status(id)).dosyalar.map((d) => d.durum)).toEqual(['okunuyor', 'sirada']));
      pending.shift()?.();
      await vi.waitFor(async () => expect((await status(id)).dosyalar.map((d) => d.durum)).toEqual(['bitti', 'okunuyor']));
      pending.shift()?.();
      await untilDone(id);
    });

    it('fails a wrong or oversized file on its own and reads the rest', async () => {
      const big = Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024 + 10)]);
      const res = await uploadMany([
        [pdf(1), 'iyi.pdf'],
        [Buffer.from('<html></html>'), 'sahte.pdf'],
        [big, 'büyük.pdf'],
      ]);
      expect(res.status).toBe(202);
      const done = await untilDone(((await res.json()) as BatchView).id);
      expect(done.dosyalar.map((d) => [d.durum, d.hata?.kod ?? null])).toEqual([
        ['bitti', null],
        ['hata', 'desteklenmeyen_dosya'],
        ['hata', 'dosya_cok_buyuk'],
      ]);
      expect(extract).toHaveBeenCalledTimes(1);
    });

    it('reports a failed read with its Turkish reason and keeps the others', async () => {
      extract.mockRejectedValueOnce(new ExtractionError('claude_limit', 'Claude kullanım sınırına ulaşıldı.'));
      await restart(undefined, undefined, { maxConcurrent: 1 });
      const done = await untilDone(((await (await uploadMany([[pdf(1), 'a.pdf'], [pdf(2), 'b.pdf']])).json()) as BatchView).id);
      expect(done.dosyalar[0]).toMatchObject({ durum: 'hata', hata: { kod: 'claude_limit', mesaj: 'Claude kullanım sınırına ulaşıldı.' } });
      expect(done.dosyalar[1]?.durum).toBe('bitti');
    });

    it('answers 200 with the invoices at once when every file was read before', async () => {
      const first = await upload(pdf(1), 'a.pdf');
      await upload(pdf(2), 'b.pdf');
      const res = await uploadMany([[pdf(1), 'a.pdf'], [pdf(2), 'b.pdf']]);
      expect(res.status).toBe(200);
      const batch = (await res.json()) as BatchView;
      expect(batch.bitti).toBe(true);
      expect(batch.dosyalar[0]).toEqual({
        sira: 1,
        dosyaAdi: 'a.pdf',
        dosyaOzeti: createHash('sha256').update(pdf(1)).digest('hex'),
        durum: 'bitti',
        kayitId: first.headers.get('x-fatura-id'),
        onbellek: true,
        hata: null,
        sonuc: sampleInvoice(),
        // Answered from the record: never in the queue.
        kuyrukSirasi: null,
        onundeki: null,
      });
      expect(batch.dosyalar[1]).toMatchObject({ durum: 'bitti', onbellek: true, sonuc: sampleInvoice() });
      expect(extract).toHaveBeenCalledTimes(2);
    });

    it('returns stored invoices in the 202 answer and queues only the new files', async () => {
      await upload(pdf(1), 'eski.pdf');
      const res = await uploadMany([[pdf(2), 'yeni.pdf'], [pdf(1), 'eski.pdf']]);
      expect(res.status).toBe(202);
      const batch = (await res.json()) as BatchView;
      expect(batch.dosyalar[0]).toMatchObject({ durum: expect.stringMatching(/^(sirada|okunuyor)$/), sonuc: null });
      expect(batch.dosyalar[1]).toMatchObject({ durum: 'bitti', onbellek: true, sonuc: sampleInvoice() });
      const done = await untilDone(batch.id);
      expect(done.dosyalar[0]).toMatchObject({ durum: 'bitti', onbellek: false, sonuc: sampleInvoice() });
    });

    it('returns stored results for files read before, and reads again with ?yenile=1', async () => {
      const first = await upload(pdf(1));
      const reused = await untilDone(((await (await uploadMany([[pdf(1), 'a.pdf']])).json()) as BatchView).id);
      expect(reused.dosyalar[0]).toMatchObject({ onbellek: true, kayitId: first.headers.get('x-fatura-id') });
      expect(extract).toHaveBeenCalledTimes(1);

      const fresh = await untilDone(((await (await uploadMany([[pdf(1), 'a.pdf']], '?yenile=1')).json()) as BatchView).id);
      expect(fresh.dosyalar[0]?.onbellek).toBe(false);
      expect(extract).toHaveBeenCalledTimes(2);
    });

    it('accepts any field name and keeps Turkish file names', async () => {
      const res = await uploadMany([[pdf(1), 'şubat faturası.pdf']], '', 'file');
      expect(((await res.json()) as BatchView).dosyalar[0]?.dosyaAdi).toBe('şubat faturası.pdf');
    });

    it('rejects a form without files', async () => {
      const form = new FormData();
      form.append('not', 'yalnızca metin');
      const res = await fetch(`${base}/api/invoices/toplu`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { hata: { kod: string } }).hata.kod).toBe('dosya_yok');
    });

    it('rejects a raw body: several files need multipart', async () => {
      const res = await fetch(`${base}/api/invoices/toplu`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: PDF_BYTES });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { hata: { kod: string } }).hata.kod).toBe('gecersiz_form');
    });

    it('rejects too many files', async () => {
      await restart(undefined, undefined, { maxBatchFiles: 2 });
      const res = await uploadMany([1, 2, 3].map((i): [Buffer, string] => [pdf(i), `${i}.pdf`]));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ hata: { kod: 'cok_fazla_dosya', mesaj: 'Bir seferde en fazla 2 dosya gönderilebilir.' } });
      expect(extract).not.toHaveBeenCalled();
    });

    it('rejects a request over the total size limit', async () => {
      await restart(undefined, undefined, { maxBatchBytes: 1024 * 1024 });
      const res = await uploadMany([[Buffer.concat([PDF_BYTES, Buffer.alloc(2 * 1024 * 1024 + 10)]), 'a.pdf']]);
      expect(res.status).toBe(413);
      expect(((await res.json()) as { hata: { kod: string } }).hata.kod).toBe('istek_cok_buyuk');
    });

    it('returns 404 for unknown or malformed queue ids', async () => {
      for (const id of ['20261106-000000-deadbeef', '..%2F..%2Fpackage']) {
        const res = await fetch(`${base}/api/invoices/toplu/${id}`);
        expect(res.status).toBe(404);
      }
    });

    it('rejects cross-site multi-file uploads', async () => {
      const res = await raw('/api/invoices/toplu', { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' }, 'POST', PDF_BYTES);
      expect(res.status).toBe(403);
      expect(extract).not.toHaveBeenCalled();
    });
  });

  describe('live monitor', () => {
    const pdf = (i: number): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(String(i))]);
    const monitor = async (): Promise<LiveSnapshot> => (await (await fetch(`${base}/api/izleme`)).json()) as LiveSnapshot;
    const send = (buf: Buffer, name: string, headers: Record<string, string> = {}, path = '/api/invoices'): Promise<Response> => {
      const form = new FormData();
      form.append(path.endsWith('toplu') ? 'files' : 'file', new Blob([new Uint8Array(buf)]), name);
      return fetch(`${base}${path}`, { method: 'POST', body: form, headers });
    };

    /** Reads Server-Sent Events one at a time. */
    const openStream = async () => {
      const abort = new AbortController();
      const res = await fetch(`${base}/api/izleme/akis`, { signal: abort.signal });
      const body = res.body;
      if (body === null) throw new Error('no body');
      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      const next = async (): Promise<{ event: string; data: unknown }> => {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event !== undefined && data !== undefined) return { event, data: JSON.parse(data) };
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error('stream ended');
          buffer += chunk.value;
        }
      };
      return { res, next, close: () => abort.abort() };
    };

    it('shows uploads from API clients and from the panel', async () => {
      await send(pdf(1), 'api.pdf');
      await send(pdf(2), 'panel.pdf', { 'X-Panel-Etiket': 'p-123' });
      await send(pdf(3), 'bozuk-etiket.pdf', { 'X-Panel-Etiket': 'kötü etiket!' });
      const { etkinlikler, istatistik } = await monitor();
      expect(etkinlikler.map((a) => [a.dosyaAdi, a.kaynak, a.etiket, a.durum])).toEqual([
        ['bozuk-etiket.pdf', 'api', null, 'bitti'],
        ['panel.pdf', 'panel', 'p-123', 'bitti'],
        ['api.pdf', 'api', null, 'bitti'],
      ]);
      expect(etkinlikler[2]).toMatchObject({ kayitId: expect.any(String), ozet: { faturaNo: 'ABC2026000000123', kalemSayisi: 1 } });
      expect(istatistik).toMatchObject({ esZamanli: 2, bitti: 3, okunuyor: 0, sirada: 0 });
    });

    it('shows multi-file uploads with their queue and position, refused files included', async () => {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(pdf(1))]), 'a.pdf');
      form.append('files', new Blob(['<html></html>']), 'sahte.pdf');
      const res = await fetch(`${base}/api/invoices/toplu`, { method: 'POST', body: form, headers: { 'X-Panel-Etiket': 'kuyruk-1' } });
      const batch = (await res.json()) as BatchView;
      await vi.waitFor(async () => expect((await monitor()).istatistik.bitti).toBe(1));
      const { etkinlikler } = await monitor();
      expect(etkinlikler.map((a) => [a.dosyaAdi, a.kuyrukId, a.sira, a.kaynak, a.etiket, a.durum, a.hata?.kod ?? null])).toEqual(
        expect.arrayContaining([
          ['a.pdf', batch.id, 1, 'panel', 'kuyruk-1', 'bitti', null],
          ['sahte.pdf', batch.id, 2, 'panel', 'kuyruk-1', 'hata', 'desteklenmeyen_dosya'],
        ]),
      );
    });

    it('shows a refused single upload with the reason', async () => {
      expect((await send(Buffer.from('<html></html>'), 'not.html')).status).toBe(415);
      expect((await monitor()).etkinlikler[0]).toMatchObject({ dosyaAdi: 'not.html', durum: 'hata', hata: { kod: 'desteklenmeyen_dosya' } });
    });

    it('streams the current state first, then every change', async () => {
      const pending: Array<() => void> = [];
      extract.mockImplementation(
        (_file, hooks) =>
          new Promise<Extraction>((resolve) => {
            hooks?.onModel?.('haiku');
            pending.push(() => resolve(sampleExtraction()));
          }),
      );
      const stream = await openStream();
      expect(stream.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const first = await stream.next();
      expect(first).toEqual({ event: 'durum', data: expect.objectContaining({ etkinlikler: [] }) });

      const upload = send(pdf(1), 'canli.pdf');
      const seen: string[] = [];
      for (;;) {
        const { event, data } = await stream.next();
        expect(event).toBe('etkinlik');
        const { etkinlik } = data as LiveEvent;
        seen.push(`${etkinlik.durum}:${etkinlik.model ?? '-'}`);
        if (etkinlik.model === 'haiku') pending.shift()?.();
        if (etkinlik.durum === 'bitti') break;
      }
      expect(seen).toEqual(['sirada:-', 'okunuyor:-', 'okunuyor:haiku', 'bitti:claude-sonnet-5-5']);
      expect((await upload).status).toBe(201);
      stream.close();
    });

    it('ends the stream once the session is gone, without extending a live one', async () => {
      await restart(1024 * 1024, () => {}, { liveHeartbeatMs: 50 });
      const stream = await openStream(); // opening it is a use of the session like any request
      expect((await stream.next()).event).toBe('durum');

      // From here on only heartbeats check the session; they must not extend it.
      await execute(db, 'UPDATE dbo.oturumlar SET son_erisim = DATEADD(MINUTE, -10, SYSUTCDATETIME())');
      const before = await queryOne<{ son_kullanma: Date }>(db, 'SELECT son_kullanma FROM dbo.oturumlar');
      await new Promise((r) => setTimeout(r, 200)); // a few heartbeats
      const after = await queryOne<{ son_kullanma: Date }>(db, 'SELECT son_kullanma FROM dbo.oturumlar');
      expect(after?.son_kullanma).toEqual(before?.son_kullanma);

      await execute(db, 'DELETE FROM dbo.oturumlar');
      await expect(stream.next()).rejects.toThrow('stream ended');
    });
  });

  it('judges the file by content, not by its name', async () => {
    const res = await upload(Buffer.from('<html>bu bir pdf değil</html>'), 'fatura.pdf');
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ hata: { kod: 'desteklenmeyen_dosya', mesaj: expect.any(String) } });
    expect(extract).not.toHaveBeenCalled();
  });

  it('rejects a request without a file', async () => {
    const res = await fetch(`${base}/api/invoices`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { hata: { kod: string } }).hata.kod).toBe('dosya_yok');
  });

  it('rejects a form without the "file" field', async () => {
    const form = new FormData();
    form.append('belge', new Blob([new Uint8Array(PDF_BYTES)]), 'a.pdf');
    const res = await fetch(`${base}/api/invoices`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('rejects files over the size limit', async () => {
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024 + 10)]);
    const res = await fetch(`${base}/api/invoices`, { method: 'POST', body: big, headers: { 'X-File-Name': 'b.pdf' } });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { hata: { kod: string } }).hata.kod).toBe('dosya_cok_buyuk');
    expect(extract).not.toHaveBeenCalled();
  });

  it.each([
    ['claude_auth', 503],
    ['claude_limit', 429],
    ['claude_failed', 502],
    ['claude_timeout', 504],
    ['invalid_output', 422],
  ] as const)('maps extraction error %s to HTTP %i without storing', async (code, status) => {
    extract.mockRejectedValueOnce(new ExtractionError(code, 'ayrıntı'));
    const res = await upload(PDF_BYTES);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ hata: { kod: code, mesaj: 'ayrıntı' } });
    expect(await storage.list()).toEqual([]);
  });

  it('hides unexpected error details', async () => {
    extract.mockRejectedValueOnce(new Error('C:\\gizli\\yol patladı'));
    const res = await upload(PDF_BYTES);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('gizli');
  });

  it('returns 404 for unknown or malformed ids', async () => {
    for (const id of ['20261105-000000-deadbeef', '..%2F..%2Fpackage']) {
      const res = await fetch(`${base}/api/invoices/${id}`);
      expect(res.status).toBe(404);
    }
  });

  it('serves the panel', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Masraf</title>');
    expect(html).toContain('src="js/main.js"');
  });

  it.each([
    ['/js/main.js', 'javascript'],
    ['/js/monitor.js', 'javascript'],
    ['/css/app.css', 'text/css'],
  ])('serves the panel file %s', async (path, type) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(type);
  });

  it.each(['evil.example:80', '127.0.0.1.nip.io:4000', '127.0.0.1'])('rejects foreign Host %s', async (host) => {
    const res = await raw('/api/invoices', { Host: host });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ hata: { kod: 'izinsiz_host' } });
  });

  it('accepts localhost as Host', async () => {
    const res = await raw('/health', { Host: `localhost:${port}` });
    expect(res.status).toBe(200);
  });

  it("answers to the machine's local network address only when opened to the local network", async () => {
    // restart() listens on a new port, so the headers are built for the current one each time.
    const lan = () => ({ Host: `192.168.1.20:${port}`, Origin: `http://192.168.1.20:${port}` });
    expect(JSON.parse((await raw('/api/invoices', lan())).body)).toMatchObject({ hata: { kod: 'izinsiz_host' } });

    await restart(1024 * 1024, () => {}, { lanHosts: () => ['192.168.1.20'] });
    expect((await raw('/api/invoices', lan())).status).toBe(200);
    expect((await raw('/api/invoices', { Host: `127.0.0.1:${port}` })).status).toBe(200);
    expect(JSON.parse((await raw('/api/invoices', { Host: `192.168.1.21:${port}` })).body)).toMatchObject({ hata: { kod: 'izinsiz_host' } });
    expect(JSON.parse((await raw('/api/invoices', { Host: `192.168.1.20:${port}`, Origin: 'http://192.168.1.21' })).body)).toMatchObject({
      hata: { kod: 'izinsiz_kaynak' },
    });
  });

  it('rejects cross-site browser uploads', async () => {
    const res = await raw('/api/invoices', { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' }, 'POST', PDF_BYTES);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ hata: { kod: 'izinsiz_kaynak' } });
    expect(extract).not.toHaveBeenCalled();
  });

  it('accepts same-origin browser uploads', async () => {
    const res = await raw(
      '/api/invoices',
      { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/pdf' },
      'POST',
      PDF_BYTES,
    );
    expect(res.status).toBe(201);
  });
});
