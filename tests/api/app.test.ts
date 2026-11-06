import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp } from '../src/app.ts';
import { ExtractionError, type ExtractInvoice } from '../src/claude-extractor.ts';
import { createInvoiceStorage, type InvoiceStorage } from '../src/storage.ts';
import { PDF_BYTES, PNG_BYTES, sampleExtraction, sampleInvoice, sampleOlcum } from './helpers.ts';

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe('HTTP API', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let port: number;
  let storage: InvoiceStorage;
  let extract: Mock<ExtractInvoice>;

  const start = async (maxFileBytes = 1024 * 1024, log: (line: string) => void = () => {}): Promise<void> => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    server.on('request', createApp({ extract, storage, maxFileBytes, port, log }));
  };

  /** node:http lets the test send arbitrary Host and Origin headers. */
  const raw = (path: string, headers: Record<string, string>, method = 'GET', body?: Buffer): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fatura-app-'));
    storage = createInvoiceStorage(dir);
    extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    await start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
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
    expect(extract).toHaveBeenCalledWith({ buffer: PDF_BYTES, type: { mime: 'application/pdf', ext: 'pdf' } });

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
    expect(extract).toHaveBeenCalledWith({ buffer: PNG_BYTES, type: { mime: 'image/png', ext: 'png' } });
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
    expect(await res.text()).toContain('Fatura Okuyucu');
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
