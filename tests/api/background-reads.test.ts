// Saving a form before its files are read, over HTTP (docs/onay-sistemi.md, section 3, "Arka planda
// okuma ve 'okununca gönder'", and section 6): validation, the queue places clients show, the background
// read through the real reader, reading a failed file again, and resuming after a restart.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/app.ts';
import { ExtractionError, type ExtractInvoice } from '../../src/claude/extractor.ts';
import { execute, p, query, type Db } from '../../src/db/sql.ts';
import type { PendingReads } from '../../src/reading/pending-reads.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { PDF_BYTES, sampleExtraction, sampleInvoice, sampleOlcum } from '../helpers.ts';
import { chainOf, closeTestDb, makeUser, resetDb, setFlow, testDb, tokenFor } from '../db.ts';

interface Answer {
  readonly status: number;
  readonly body: any;
}

const PAST = '2025-06-15';
const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('reading in the background over HTTP', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let extract: Mock<ExtractInvoice>;
  let pending: PendingReads;
  let approver: Kullanici;
  let owner: Kullanici;
  let outsider: Kullanici;
  let fileCount = 0;
  const tokens = new Map<number, string>();

  /** Claude calls wait here until released, in the order they started. */
  let gates: Array<() => void> = [];
  const held = (): Promise<void> => new Promise<void>((resolve) => gates.push(resolve));
  const releaseAll = (): void => {
    const now = gates;
    gates = [];
    for (const release of now) release();
  };

  const start = async (extra: Partial<AppDeps> = {}): Promise<void> => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    server.on(
      'request',
      createApp({ extract, db, maxFileBytes: 1024 * 1024, port, maxConcurrent: 1, log: () => {}, onPendingReads: (w) => (pending = w), ...extra }),
    );
  };
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
    approver = await makeUser(db, { adSoyad: 'Onaycı' });
    owner = await makeUser(db, { adSoyad: 'Sahip' });
    outsider = await makeUser(db, { adSoyad: 'Başkası' });
    tokens.clear();
    for (const u of [approver, owner, outsider]) tokens.set(u.id, await tokenFor(db, u.id));
    await setFlow(db, chainOf(approver.id));
    gates = [];
    // Each file its own seller tax number, so two files are never the same invoice.
    extract = vi.fn<ExtractInvoice>(async () => {
      await held();
      return { sonuc: sampleInvoice({ saticiVergiNo: String(3_000_000_000 + extract.mock.calls.length) }), olcum: sampleOlcum() };
    });
    await start();
  });
  afterEach(async () => {
    releaseAll();
    await pending.idle();
    await stop();
  });

  const call = async (who: Kullanici, method: string, path: string, body?: unknown): Promise<Answer> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokens.get(who.id) ?? ''}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  };
  const fieldError = (res: Answer, alan: string): void => {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.hata).toMatchObject({ kod: 'gecersiz_istek', alanlar: { [alan]: expect.any(String) } });
  };

  const newFile = (): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(`\n% bekleyen ${++fileCount} ${Date.now()}\n`)]);
  /** Sends files in one multi-file upload; answers the batch id. */
  const uploadMany = async (who: Kullanici, files: readonly Buffer[]): Promise<string> => {
    const form = new FormData();
    files.forEach((f, i) => form.append('files', new Blob([new Uint8Array(f)]), `fiş-${i + 1}.pdf`));
    const res = await fetch(`${base}/api/invoices/toplu`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(who.id) ?? ''}` }, body: form });
    expect(res.status).toBe(202);
    return ((await res.json()) as { id: string }).id;
  };
  const batch = async (who: Kullanici, id: string): Promise<any> => (await call(who, 'GET', `/api/invoices/toplu/${id}`)).body;
  const notifications = () => query<{ kullanici_id: number; tur: string }>(db, 'SELECT kullanici_id, tur FROM dbo.bildirimler ORDER BY id');

  describe('validation', () => {
    it('takes an empty amount on a draft, and refuses bad waiting files and a send together with "okununca gönder"', async () => {
      const draft = await call(owner, 'POST', '/api/masraflar', { baslik: 'Taksi', kategoriId: 1, masrafTarihi: PAST, tutar: null });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      expect(draft.body).toMatchObject({ durum: 'taslak', tutar: null, yerelTutar: null, okununcaGonder: false, bekleyenFaturalar: [], okuma: null });
      expect((await call(owner, 'PATCH', `/api/masraflar/${draft.body.id}`, { tutar: 12.5 })).body.tutar).toBe(12.5);
      expect((await call(owner, 'PATCH', `/api/masraflar/${draft.body.id}`, { tutar: null })).body.tutar).toBeNull();
      const send = await call(owner, 'POST', `/api/masraflar/${draft.body.id}/gonder`, {});
      expect(send.status).toBe(409);
      expect(send.body.hata).toMatchObject({ kod: 'tutar_eksik', alanlar: { tutar: expect.any(String) } });

      const body = { baslik: 'Taksi', kategoriId: 1, masrafTarihi: PAST };
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, bekleyenFaturalar: ['abc'] }), 'bekleyenFaturalar.0');
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, bekleyenFaturalar: ['A'.repeat(64)] }), 'bekleyenFaturalar.0');
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, bekleyenFaturalar: ['a'.repeat(64), 'a'.repeat(64)] }), 'bekleyenFaturalar.1');
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, bekleyenFaturalar: Array.from({ length: 21 }, (_, i) => String(i).padStart(64, '0')) }), 'bekleyenFaturalar');
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, okununcaGonder: 'evet' }), 'okununcaGonder');
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, tutar: 5, okununcaGonder: true, gonder: true }), 'okununcaGonder');
      // A file the server does not have for the user.
      fieldError(await call(owner, 'POST', '/api/masraflar', { ...body, bekleyenFaturalar: ['b'.repeat(64)] }), 'bekleyenFaturalar.0');
    });
  });

  it('shows each file\'s place in the queue, saves the form while they are read and sends it once they are', async () => {
    const files = [newFile(), newFile()];
    const id = await uploadMany(owner, files);
    // One reader: the first file is being read, the second waits behind it.
    await vi.waitFor(async () => {
      const b = await batch(owner, id);
      expect(b.dosyalar[0]).toMatchObject({ durum: 'okunuyor', kuyrukSirasi: null, onundeki: null, dosyaOzeti: hashOf(files[0] as Buffer) });
      expect(b.dosyalar[1]).toMatchObject({ durum: 'sirada', kuyrukSirasi: 1, onundeki: 1, dosyaOzeti: hashOf(files[1] as Buffer) });
    });
    const monitor = await call(owner, 'GET', '/api/izleme');
    expect(monitor.body.etkinlikler.find((e: { durum: string }) => e.durum === 'sirada')).toMatchObject({ kuyrukSirasi: 1, onundeki: 1 });

    const saved = await call(owner, 'POST', '/api/masraflar', {
      baslik: 'Saha gezisi',
      kategoriId: 1,
      masrafTarihi: PAST,
      bekleyenFaturalar: files.map(hashOf),
      okununcaGonder: true,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ durum: 'taslak', tutar: null, okununcaGonder: true, okuma: { bekleyen: 2, hatali: 0 }, faturaIdler: [] });
    expect(saved.body.bekleyenFaturalar).toEqual([
      expect.objectContaining({ dosyaOzeti: hashOf(files[0] as Buffer), dosyaAdi: 'fiş-1.pdf', durum: 'okunuyor', kuyrukSirasi: null, onundeki: null, hata: null }),
      expect.objectContaining({ dosyaOzeti: hashOf(files[1] as Buffer), dosyaAdi: 'fiş-2.pdf', durum: 'sirada', kuyrukSirasi: 1, onundeki: 1, hata: null }),
    ]);
    const list = await call(owner, 'GET', '/api/masraflar');
    expect(list.body.kayitlar[0]).toMatchObject({ id: saved.body.id, tutar: null, okuma: { bekleyen: 2, hatali: 0 } });

    // Claude reads both files once: the background read joins the uploads' reads.
    await vi.waitFor(() => {
      releaseAll();
      expect(extract).toHaveBeenCalledTimes(2);
    });
    releaseAll();
    await vi.waitFor(async () => expect((await batch(owner, id)).bitti).toBe(true));
    await pending.idle();
    expect(extract).toHaveBeenCalledTimes(2);

    const done = await batch(owner, id);
    const after = await call(owner, 'GET', `/api/masraflar/${saved.body.id}`);
    expect(after.body).toMatchObject({
      durum: 'onayda',
      okununcaGonder: false,
      bekleyenFaturalar: [],
      okuma: null,
      faturaIdler: [done.dosyalar[0].kayitId, done.dosyalar[1].kayitId],
      tutar: 3600,
      satici: 'Örnek Yazılım A.Ş.',
      siradakiOnayci: { id: approver.id },
    });
    // Each invoice names the file it was read from.
    expect(after.body.faturalar.map((f: { dosyaOzeti: string }) => f.dosyaOzeti)).toEqual(files.map(hashOf));
    expect(await notifications()).toEqual([
      { kullanici_id: approver.id, tur: 'onay_bekliyor' },
      { kullanici_id: owner.id, tur: 'onaya_gonderildi' },
    ]);
  });

  it('keeps a failed file on the form until the owner reads it again, in the background', async () => {
    extract.mockImplementationOnce(async () => {
      await held();
      throw new ExtractionError('claude_failed', 'Claude faturayı okuyamadı.');
    });
    const file = newFile();
    await uploadMany(owner, [file]);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const saved = await call(owner, 'POST', '/api/masraflar', { baslik: 'Otopark', kategoriId: 1, masrafTarihi: PAST, tutar: 40, bekleyenFaturalar: [hashOf(file)] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    releaseAll();
    await pending.idle();

    const failed = await call(owner, 'GET', `/api/masraflar/${saved.body.id}`);
    expect(failed.body).toMatchObject({ okuma: { bekleyen: 0, hatali: 1 }, bekleyenFaturalar: [{ durum: 'hata', hata: { kod: 'claude_failed', mesaj: 'Claude faturayı okuyamadı.' } }] });
    const send = await call(owner, 'POST', `/api/masraflar/${saved.body.id}/gonder`, {});
    expect(send.status).toBe(409);
    expect(send.body.hata.kod).toBe('okuma_hatali');
    expect(await notifications()).toEqual([{ kullanici_id: owner.id, tur: 'okuma_hatasi' }]);

    expect((await call(outsider, 'POST', `/api/masraflar/${saved.body.id}/yeniden-oku`, {})).status).toBe(404);
    const again = await call(owner, 'POST', `/api/masraflar/${saved.body.id}/yeniden-oku`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.okuma).toEqual({ bekleyen: 1, hatali: 0 });
    await vi.waitFor(() => {
      releaseAll();
      expect(extract).toHaveBeenCalledTimes(2);
    });
    releaseAll();
    await pending.idle();

    const read = await call(owner, 'GET', `/api/masraflar/${saved.body.id}`);
    expect(read.body).toMatchObject({ okuma: null, bekleyenFaturalar: [], faturaIdler: [expect.any(String)] });
    // The new read shows in the owner's monitor as a background one.
    const monitor = await call(owner, 'GET', '/api/izleme');
    expect(monitor.body.etkinlikler[0]).toMatchObject({ kaynak: 'arka_plan', durum: 'bitti', kullanici: { id: owner.id } });
    expect((await call(owner, 'POST', `/api/masraflar/${saved.body.id}/gonder`, {})).body.durum).toBe('onayda');
  });

  it('reads the files that were still waiting when the server stopped', async () => {
    const saved = await call(owner, 'POST', '/api/masraflar', { baslik: 'Yemek', kategoriId: 1, masrafTarihi: PAST });
    const file = newFile();
    await execute(
      db,
      `INSERT INTO dbo.bekleyen_faturalar (form_id, kullanici_id, dosya_adi, dosya_ozeti, mime, boyut, icerik) VALUES (@f, @u, N'fiş.pdf', @h, 'application/pdf', @b, @i)`,
      { f: p.int(saved.body.id), u: p.int(owner.id), h: p.ascii(hashOf(file), 64), b: p.int(file.length), i: p.bytes(file) },
    );
    await stop();
    extract.mockImplementation(async () => sampleExtraction());
    await start({ resumeReads: true });
    await pending.idle();
    const after = await call(owner, 'GET', `/api/masraflar/${saved.body.id}`);
    expect(after.body).toMatchObject({ okuma: null, bekleyenFaturalar: [], faturaIdler: [expect.any(String)], tutar: 1800 });
    expect(await notifications()).toEqual([{ kullanici_id: owner.id, tur: 'okuma_bitti' }]);
    // The read is the owner's upload: they may open the invoice.
    expect((await call(owner, 'GET', `/api/invoices/${after.body.faturaIdler[0]}`)).status).toBe(200);
  });
});
