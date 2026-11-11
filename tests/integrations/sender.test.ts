// The integration send job (docs/onay-sistemi.md, section 9, "Gönderim zamanı ve kuyruk") against a real
// HTTP server on 127.0.0.1: what reaches the address, which failures are tried again, and that the
// password never lands in the log.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute, p, query, queryOne, type Db } from '../../src/db/sql.ts';
import { createExpenseService, type ExpenseService } from '../../src/expenses/forms.ts';
import { createPayloadLoader } from '../../src/integrations/form-data.ts';
import { createSecretBox, type SecretBox } from '../../src/integrations/secret.ts';
import { createIntegrationSender, type SenderOptions } from '../../src/integrations/sender.ts';
import { createIntegration, queueManual, type EntegrasyonGirdi } from '../../src/integrations/store.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { chainOf, closeTestDb, makeInvoice, makeUser, resetDb, setFlow, testDb } from '../db.ts';

const PASSWORD = 'PiParola-2026!';
const box = createSecretBox('b'.repeat(40)) as SecretBox;

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

describe('integration send job', () => {
  let db: Db;
  let svc: ExpenseService;
  let admin: Kullanici;
  let worker: Kullanici;
  let target: Server;
  let address: string;
  let received: Received[];
  /** The next replies of the target, in order; afterwards 200. */
  let replies: Array<{ status: number; body?: string; headers?: Record<string, string> }>;
  let clock: Date;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);

  beforeEach(async () => {
    await resetDb(db);
    admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    worker = await makeUser(db, { adSoyad: 'Ayşe Kaya' });
    await setFlow(db, chainOf(admin.id));
    svc = createExpenseService(db, { baseCurrency: 'TRY' });
    received = [];
    replies = [];
    // A little ahead of the database clock, which stamps a queued send as due now.
    clock = new Date(Date.now() + 5_000);
    target = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const reply = replies.shift() ?? { status: 200, body: '{"durum":"alindi"}' };
        res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
        res.end(reply.body ?? '');
      });
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(target.address() as AddressInfo).port}/RESTAdapter/masraf`;
  });

  afterEach(async () => {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  const sender = (over: Partial<SenderOptions> = {}) =>
    createIntegrationSender({ db, load: createPayloadLoader(db, svc, 'TRY'), box, maxAttempts: 3, now: () => clock, log: () => {}, ...over });

  const settings = (over: Partial<EntegrasyonGirdi> = {}): EntegrasyonGirdi => ({
    ad: 'SAP PI',
    aktif: true,
    adres: address,
    yontem: 'POST',
    bicim: 'json',
    kok: null,
    xmlAdAlani: null,
    fisListesi: 'FISLER',
    fisOgesi: 'FIS',
    tarihBicimi: 'YYYY-AA-GG',
    tetikleyici: 'onaylandi',
    kimlik: { tur: 'basic', kullanici: 'PIUSER', sifre: PASSWORD },
    basliklar: [{ ad: 'X-Kaynak', deger: 'masraf' }],
    zamanAsimiSn: 30,
    alanlar: [
      { kaynak: 'form.no', alias: 'NO' },
      { kaynak: 'form.tutar', alias: 'TTR' },
      { kaynak: 'fis.faturaNo', alias: 'BELNR' },
    ],
    ...over,
  });

  /** A form sent by the worker and approved: the trigger of an "onaylandi" integration. */
  async function approvedForm(): Promise<number> {
    const invoice = await makeInvoice(db, worker.id, { faturaNo: 'A-1', genelToplam: 2193.39 });
    const sent = await svc.create(worker, { baslik: 'Müşteri yemeği', kategoriId: 1, masrafTarihi: '2026-11-01', tutar: 2193.39, faturaIdler: [invoice] }, true);
    await svc.approve(sent.id, admin, null);
    return sent.id;
  }

  interface SendRow {
    durum: string;
    deneme: number;
    http_durum: number | null;
    son_hata: string | null;
    govde: string | null;
    icerik_turu: string | null;
    yanit: string | null;
    sonraki_deneme: Date | null;
    gonderim: Date | null;
  }
  const sendRows = (): Promise<SendRow[]> =>
    query<SendRow>(db, 'SELECT durum, deneme, http_durum, son_hata, govde, icerik_turu, yanit, sonraki_deneme, gonderim FROM dbo.entegrasyon_gonderimleri ORDER BY id');

  it('posts the body with its content type, the extra headers and Basic credentials, and keeps the body and the reply', async () => {
    await createIntegration(db, admin, settings(), box);
    const formId = await approvedForm();
    expect(await sender().runOnce()).toBe(1);

    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/RESTAdapter/masraf');
    expect(req.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(req.headers['x-kaynak']).toBe('masraf');
    expect(Buffer.from(String(req.headers.authorization).replace(/^Basic /, ''), 'base64').toString('utf8')).toBe(`PIUSER:${PASSWORD}`);
    expect(JSON.parse(req.body)).toEqual({ NO: formId, TTR: 2193.39, FISLER: [{ BELNR: 'A-1' }] });

    const [row] = await sendRows();
    expect(row).toMatchObject({ durum: 'gonderildi', deneme: 1, http_durum: 200, son_hata: null, govde: req.body, icerik_turu: 'application/json; charset=utf-8', yanit: '{"durum":"alindi"}', sonraki_deneme: null });
    expect(row?.gonderim).toEqual(clock);
    // Nothing left to do.
    expect(await sender().runOnce()).toBe(0);
  });

  it('tries a server error again at growing intervals and gives up after the last attempt', async () => {
    await createIntegration(db, admin, settings(), box);
    await approvedForm();
    replies = [{ status: 503, body: 'PI kapalı' }, { status: 500 }, { status: 502 }];
    const job = sender();
    await job.runOnce();
    let [row] = await sendRows();
    expect(row).toMatchObject({ durum: 'bekliyor', deneme: 1, http_durum: 503, son_hata: 'HTTP 503: PI kapalı', yanit: 'PI kapalı' });
    expect(row?.sonraki_deneme).toEqual(new Date(clock.getTime() + 60_000));

    // Not due yet.
    expect(await job.runOnce()).toBe(0);
    clock = new Date(clock.getTime() + 60_000);
    await job.runOnce();
    [row] = await sendRows();
    expect(row).toMatchObject({ durum: 'bekliyor', deneme: 2, http_durum: 500, son_hata: 'HTTP 500', yanit: null });
    expect(row?.sonraki_deneme).toEqual(new Date(clock.getTime() + 5 * 60_000));

    clock = new Date(clock.getTime() + 5 * 60_000);
    await job.runOnce();
    [row] = await sendRows();
    expect(row).toMatchObject({ durum: 'hata', deneme: 3, http_durum: 502, sonraki_deneme: null, gonderim: null });
    expect(received).toHaveLength(3);
  });

  it('gives up at once on a client error or a redirect, which trying again cannot fix, and follows no redirect', async () => {
    await createIntegration(db, admin, settings(), box);
    await approvedForm();
    await approvedForm();
    replies = [{ status: 400, body: '{"hata":"BELNR boş"}' }, { status: 302, headers: { Location: 'http://127.0.0.1:1/baska' } }];
    await sender().runOnce();
    const rows = await sendRows();
    expect(rows.map((r) => [r.durum, r.deneme, r.http_durum])).toEqual([
      ['hata', 1, 400],
      ['hata', 1, 302],
    ]);
    expect(rows[0]?.son_hata).toBe('HTTP 400: {"hata":"BELNR boş"}');
    expect(rows[1]?.son_hata).toBe('HTTP 302 (yönlendirme izlenmez: http://127.0.0.1:1/baska)');
    expect(received).toHaveLength(2);
  });

  it('tries a refused connection and a timeout again, saying what happened', async () => {
    // A port that was free a moment ago: nothing listens there.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await createIntegration(db, admin, settings({ adres: `http://127.0.0.1:${port}/kapali` }), box);
    await approvedForm();
    await sender().runOnce();
    expect((await sendRows())[0]).toMatchObject({ durum: 'bekliyor', deneme: 1, http_durum: null, son_hata: 'Bağlantı kurulamadı: ECONNREFUSED' });

    clock = new Date(clock.getTime() + 60_000);
    const timeout: typeof fetch = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await sender({ fetch: timeout }).runOnce();
    expect((await sendRows())[0]).toMatchObject({ durum: 'bekliyor', deneme: 2, son_hata: 'Zaman aşımı (30 sn).' });
  });

  it('never writes the password or the Authorization header into the log, even when the reply repeats them', async () => {
    await createIntegration(db, admin, settings(), box);
    await approvedForm();
    const auth = `Basic ${Buffer.from(`PIUSER:${PASSWORD}`).toString('base64')}`;
    replies = [{ status: 500, body: `yetki hatası: ${auth} / ${PASSWORD}` }];
    await sender().runOnce();
    const [row] = await sendRows();
    expect(row?.son_hata).toContain('***');
    expect(row?.son_hata).not.toContain(PASSWORD);
    expect(row?.son_hata).not.toContain(Buffer.from(`PIUSER:${PASSWORD}`).toString('base64'));
    expect(row?.govde).not.toContain(PASSWORD);
  });

  it('builds no body and sends nothing when the mapping lost a field or the password cannot be opened', async () => {
    await execute(db, `INSERT INTO dbo.alan_tanimlari (anahtar, ad, duzey, tur, sira) VALUES ('plaka', N'Plaka', 'fis', 'metin', 50)`);
    await createIntegration(db, admin, settings({ ad: 'Eşleme', alanlar: [{ kaynak: 'fis.alan.plaka', alias: 'PLAKA' }] }), box);
    await createIntegration(db, admin, settings({ ad: 'Şifre' }), box);
    await execute(db, `DELETE FROM dbo.alan_tanimlari WHERE anahtar = 'plaka'`);
    await approvedForm();
    await sender({ box: createSecretBox('c'.repeat(40)) }).runOnce();
    const rows = await query<{ ad: string; durum: string; deneme: number; son_hata: string; govde: string | null }>(
      db,
      'SELECT e.ad, g.durum, g.deneme, g.son_hata, g.govde FROM dbo.entegrasyon_gonderimleri g JOIN dbo.entegrasyonlar e ON e.id = g.entegrasyon_id ORDER BY e.ad',
    );
    expect(rows).toEqual([
      { ad: 'Eşleme', durum: 'hata', deneme: 1, son_hata: 'Alan eşlemesi düzeltilmeli: 1. satır (fis.alan.plaka): bu alan silinmiş.', govde: null },
      { ad: 'Şifre', durum: 'hata', deneme: 1, son_hata: 'Şifre çözülemedi (ENTEGRASYON_ANAHTARI değişmiş olabilir); entegrasyonun şifresini yeniden girin.', govde: null },
    ]);
    expect(received).toEqual([]);
  });

  it('holds the automatic sends of an inactive integration until it is active again, but sends the manual ones', async () => {
    const integration = await createIntegration(db, admin, settings({ kimlik: { tur: 'yok' } }), box);
    const formId = await approvedForm();
    await execute(db, 'UPDATE dbo.entegrasyonlar SET aktif = 0 WHERE id = @i', { i: p.int(integration.id) });
    await queueManual(db, admin, integration.id, formId);
    await sender().runOnce();
    expect((await sendRows()).map((r) => r.durum)).toEqual(['bekliyor', 'gonderildi']);
    expect(received[0]?.headers.authorization).toBeUndefined();

    await execute(db, 'UPDATE dbo.entegrasyonlar SET aktif = 1 WHERE id = @i', { i: p.int(integration.id) });
    await sender().runOnce();
    expect((await sendRows()).map((r) => r.durum)).toEqual(['gonderildi', 'gonderildi']);
  });

  it('sends a form once even when two jobs run at the same time', async () => {
    await createIntegration(db, admin, settings({ kimlik: { tur: 'yok' } }), box);
    await approvedForm();
    await Promise.all([sender().runOnce(), sender().runOnce()]);
    expect(received).toHaveLength(1);
    expect(await queryOne(db, `SELECT COUNT(*) AS n FROM dbo.entegrasyon_gonderimleri WHERE durum = 'gonderildi' AND deneme = 1`)).toEqual({ n: 1 });
  });

  it('sends XML with PUT, and runs at once when woken', async () => {
    await createIntegration(
      db,
      admin,
      settings({ yontem: 'PUT', bicim: 'xml', kok: 'MT_Masraf', kimlik: { tur: 'yok' }, alanlar: [{ kaynak: 'form.tutar', alias: 'TTR' }] }),
      box,
    );
    await approvedForm();
    const job = sender({ intervalMs: 60_000 });
    job.start();
    try {
      for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(received[0]).toMatchObject({ method: 'PUT', body: '<?xml version="1.0" encoding="UTF-8"?>\n<MT_Masraf>\n  <TTR>2193.39</TTR>\n</MT_Masraf>' });
      expect(received[0]?.headers['content-type']).toBe('application/xml; charset=utf-8');

      // The timer waits a minute; a kick does not.
      await approvedForm();
      job.kick();
      for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(2);
    } finally {
      await job.stop();
    }
  });
});
