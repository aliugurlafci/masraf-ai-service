// Integrations over HTTP (docs/onay-sistemi.md, section 9): administrators only, the password never
// leaves the server, the checks and their error paths, the preview, and which actions queue a send.
// The body rules are tested in tests/integrations/payload.test.ts, the send job in
// tests/integrations/sender.test.ts.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.ts';
import type { ExtractInvoice } from '../../src/claude/extractor.ts';
import { execute, p, query, queryOne, type Db } from '../../src/db/sql.ts';
import { createExpenseService, type ExpenseService, type FormInput } from '../../src/expenses/forms.ts';
import { createSecretBox, type SecretBox } from '../../src/integrations/secret.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { sampleExtraction, sampleInvoice } from '../helpers.ts';
import { assignDefinitions, chainOf, closeTestDb, fieldId, makeCostCenter, makeInvoice, makeOption, makeOrganization, makeUser, resetDb, setFlow, testDb, tokenFor } from '../db.ts';

interface Answer {
  readonly status: number;
  readonly body: any;
}

const PAST = '2026-11-01';
const PASSWORD = 'PiParola-2026!';
const box = createSecretBox('a'.repeat(40)) as SecretBox;

const integration = (over: Record<string, unknown> = {}) => ({
  ad: 'SAP PI masraf',
  adres: 'https://pi.firma.local:50001/RESTAdapter/masraf',
  bicim: 'json',
  alanlar: [{ kaynak: 'form.tutar', alias: 'TTR' }],
  ...over,
});

describe('integration API', () => {
  let db: Db;
  let svc: ExpenseService;
  let admin: Kullanici;
  let accounting: Kullanici;
  let worker: Kullanici;
  const tokens = new Map<number, string>();
  const servers: Server[] = [];
  let base: string;
  const kick = vi.fn();

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);

  /** Starts the app on a free port; returns its address. */
  async function start(withBox: SecretBox | null): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    server.on('request', createApp({ extract, db, maxFileBytes: 1024 * 1024, port, log: () => {}, integrations: { box: withBox, kick } }));
    servers.push(server);
    return `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    await resetDb(db);
    admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    accounting = await makeUser(db, { rol: 'muhasebe', adSoyad: 'Muhasebe' });
    worker = await makeUser(db, { adSoyad: 'Ayşe Kaya', departman: 'Satış' });
    tokens.clear();
    for (const u of [admin, accounting, worker]) tokens.set(u.id, await tokenFor(db, u.id));
    await setFlow(db, chainOf(admin.id));
    svc = createExpenseService(db, { baseCurrency: 'TRY' });
    kick.mockClear();
    base = await start(box);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const call = async (who: Kullanici, method: string, path: string, body?: unknown, at = base): Promise<Answer> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokens.get(who.id) ?? ''}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${at}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  };
  const expectError = (res: Answer, status: number, kod: string, alanlar?: Record<string, unknown>): void => {
    expect(res.status).toBe(status);
    expect(res.body.hata.kod).toBe(kod);
    if (alanlar !== undefined) expect(res.body.hata.alanlar).toMatchObject(alanlar);
  };

  const form = (over: Partial<FormInput> = {}): FormInput => ({ baslik: 'Müşteri yemeği', kategoriId: 1, masrafTarihi: PAST, tutar: 2193.39, ...over });

  /** A form sent by the worker and approved by the administrator. */
  async function approvedForm(over: Partial<FormInput> = {}): Promise<number> {
    const sent = await svc.create(worker, form(over), true);
    expect((await svc.approve(sent.id, admin, null)).durum).toBe('onaylandi');
    return sent.id;
  }

  const sends = async (): Promise<Array<{ entegrasyon_id: number; form_id: number; tetikleyen: string; durum: string }>> =>
    query(db, 'SELECT entegrasyon_id, form_id, tetikleyen, durum FROM dbo.entegrasyon_gonderimleri ORDER BY id');

  it('is for administrators only', async () => {
    for (const who of [accounting, worker]) {
      expectError(await call(who, 'GET', '/api/entegrasyonlar'), 403, 'yetki_yok');
      expectError(await call(who, 'POST', '/api/entegrasyonlar', integration()), 403, 'yetki_yok');
      expectError(await call(who, 'GET', '/api/entegrasyon-gonderimleri'), 403, 'yetki_yok');
    }
    expect((await call(admin, 'GET', '/api/entegrasyonlar')).body).toEqual([]);
  });

  it('adds an integration with its defaults and keeps the Basic password sealed and out of every answer', async () => {
    const created = await call(
      admin,
      'POST',
      '/api/entegrasyonlar',
      integration({ kimlik: { tur: 'basic', kullanici: 'PIUSER', sifre: PASSWORD }, basliklar: [{ ad: 'X-Kaynak', deger: 'masraf' }] }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(Number),
      ad: 'SAP PI masraf',
      aktif: true,
      adres: 'https://pi.firma.local:50001/RESTAdapter/masraf',
      yontem: 'POST',
      bicim: 'json',
      kok: null,
      xmlAdAlani: null,
      fisListesi: 'FISLER',
      fisOgesi: 'FIS',
      tarihBicimi: 'YYYY-AA-GG',
      tetikleyici: 'onaylandi',
      kimlik: { tur: 'basic', kullanici: 'PIUSER', sifreVar: true },
      basliklar: [{ ad: 'X-Kaynak', deger: 'masraf' }],
      zamanAsimiSn: 30,
      alanlar: [{ kaynak: 'form.tutar', alias: 'TTR' }],
      sorunlar: [],
      sonGonderim: null,
      olusturma: expect.any(String),
      guncelleme: expect.any(String),
      guncelleyen: { id: admin.id, adSoyad: 'Yönetici' },
    });
    const id = created.body.id as number;
    const listed = await call(admin, 'GET', '/api/entegrasyonlar');
    const one = await call(admin, 'GET', `/api/entegrasyonlar/${id}`);
    expect(listed.body).toEqual([one.body]);
    for (const answer of [created, listed, one]) expect(JSON.stringify(answer.body)).not.toContain(PASSWORD);

    const stored = await queryOne<{ sifre: Buffer }>(db, 'SELECT sifre FROM dbo.entegrasyonlar WHERE id = @i', { i: p.int(id) });
    expect(stored?.sifre.includes(Buffer.from(PASSWORD))).toBe(false);
    expect(box.open(stored?.sifre ?? Buffer.alloc(0))).toBe(PASSWORD);
    const log = await query<{ islem: string; ayrinti: string }>(db, `SELECT islem, ayrinti FROM dbo.denetim_kayitlari WHERE islem LIKE 'entegrasyon%'`);
    expect(log).toEqual([{ islem: 'entegrasyon_ekle', ayrinti: expect.stringContaining('SAP PI masraf') }]);
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
  });

  it('keeps the stored password when a change does not send one, replaces it when it does, and drops it without Basic', async () => {
    const id = (await call(admin, 'POST', '/api/entegrasyonlar', integration({ kimlik: { tur: 'basic', kullanici: 'PIUSER', sifre: PASSWORD } }))).body.id as number;
    const sealed = async () => (await queryOne<{ sifre: Buffer | null; kullanici_adi: string | null }>(db, 'SELECT sifre, kullanici_adi FROM dbo.entegrasyonlar WHERE id = @i', { i: p.int(id) }))!;
    const before = (await sealed()).sifre;

    // An empty password counts as not sent.
    for (const kimlik of [{ tur: 'basic', kullanici: 'PIUSER2' }, { tur: 'basic', kullanici: 'PIUSER2', sifre: '' }]) {
      const kept = await call(admin, 'PUT', `/api/entegrasyonlar/${id}`, integration({ ad: 'SAP PI canlı', kimlik }));
      expect(kept.status).toBe(200);
      expect(kept.body).toMatchObject({ ad: 'SAP PI canlı', kimlik: { tur: 'basic', kullanici: 'PIUSER2', sifreVar: true } });
      expect((await sealed()).sifre?.equals(before ?? Buffer.alloc(0))).toBe(true);
    }
    await call(admin, 'PUT', `/api/entegrasyonlar/${id}`, integration({ kimlik: { tur: 'basic', kullanici: 'PIUSER', sifre: 'Yeni-2026' } }));
    expect(box.open((await sealed()).sifre ?? Buffer.alloc(0))).toBe('Yeni-2026');
    const audits = await query<{ ayrinti: string }>(db, `SELECT ayrinti FROM dbo.denetim_kayitlari WHERE islem = 'entegrasyon_guncelle' ORDER BY id`);
    expect(audits.map((a) => a.ayrinti.endsWith('; şifre değişti'))).toEqual([false, false, true]);

    const none = await call(admin, 'PUT', `/api/entegrasyonlar/${id}`, integration({ kimlik: { tur: 'yok', kullanici: 'x' } }));
    expect(none.body.kimlik).toEqual({ tur: 'yok', kullanici: null, sifreVar: false });
    expect(await sealed()).toEqual({ sifre: null, kullanici_adi: null });
    // Back to Basic without a stored password: one must be given.
    expectError(await call(admin, 'PUT', `/api/entegrasyonlar/${id}`, integration({ kimlik: { tur: 'basic', kullanici: 'PIUSER' } })), 400, 'gecersiz_istek', {
      'kimlik.sifre': 'Şifre girilmelidir.',
    });
  });

  it('cannot store a password without ENTEGRASYON_ANAHTARI', async () => {
    const noKey = await start(null);
    expectError(await call(admin, 'POST', '/api/entegrasyonlar', integration({ kimlik: { tur: 'basic', kullanici: 'PI', sifre: PASSWORD } }), noKey), 409, 'anahtar_yok');
    // Without Basic nothing needs the key.
    expect((await call(admin, 'POST', '/api/entegrasyonlar', integration(), noKey)).status).toBe(201);
  });

  it('refuses a bad integration with the path of each problem', async () => {
    const bad = async (over: Record<string, unknown>, alanlar: Record<string, string>) =>
      expectError(await call(admin, 'POST', '/api/entegrasyonlar', integration(over)), 400, 'gecersiz_istek', alanlar);
    await bad({ adres: 'ftp://pi.test/x' }, { adres: 'Adres http:// ya da https:// ile başlamalıdır.' });
    await bad({ adres: 'https://kullanici:sifre@pi.test/x' }, { adres: 'Kullanıcı adını ve şifreyi adrese yazmayın; Basic kimlik doğrulamasını seçin.' });
    await bad({ adres: 'pi.test' }, { adres: 'Geçerli bir adres girin (http:// ya da https:// ile).' });
    await bad({ bicim: 'xml' }, { kok: 'XML gövdede kök öğe adı zorunludur.' });
    await bad({ bicim: 'csv' }, { bicim: 'Biçim json ya da xml olmalıdır.' });
    await bad({ alanlar: [] }, { alanlar: 'En az bir alan seçilmelidir.' });
    await bad(
      { alanlar: [{ kaynak: 'form.tutar', alias: 'TTR' }, { kaynak: 'form.yerelTutar', alias: 'ttr' }, { kaynak: 'fis.alan.yok', alias: 'YOK' }, { kaynak: 'form.no', alias: 'Form No' }] },
      {
        'alanlar.1.alias': 'Bu ad 1. satırda da kullanılıyor.',
        'alanlar.2.kaynak': 'Bu kaynak alan yok.',
        'alanlar.3.alias': 'Ad harf ya da _ ile başlamalı; yalnızca İngilizce harf, rakam, _, - ve . içermeli.',
      },
    );
    await bad({ basliklar: [{ ad: 'Authorization', deger: 'Basic eA==' }] }, { 'basliklar.0.ad': 'Bu başlık kullanılamaz; kimlik bilgisi için Basic kimlik doğrulamasını seçin.' });
    await bad({ basliklar: [{ ad: 'X-A', deger: 'a\r\nX-B: b' }] }, { 'basliklar.0.deger': 'Başlık değeri satır sonu içeremez.' });
    await bad({ zamanAsimiSn: 1 }, { zamanAsimiSn: 'Zaman aşımı en az 5 saniye olabilir.' });
    await bad({ kimlik: { tur: 'basic', sifre: 'x' } }, { 'kimlik.kullanici': 'Kullanıcı adı girilmelidir.' });
    await bad({ fazla: 1 }, {});

    expect((await call(admin, 'POST', '/api/entegrasyonlar', integration())).status).toBe(201);
    expectError(await call(admin, 'POST', '/api/entegrasyonlar', integration({ ad: 'sap pı MASRAF' })), 409, 'entegrasyon_adi_kullaniliyor');
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.entegrasyonlar')).toEqual({ n: 1 });
  });

  it('lists the sources, receipt fields included', async () => {
    const res = await call(admin, 'GET', '/api/entegrasyonlar/kaynaklar');
    expect(res.status).toBe(200);
    expect(res.body.form).toContainEqual({ anahtar: 'form.tutar', ad: 'Tutar', tur: 'tutar', aktif: true });
    expect(res.body.fis).toContainEqual({ anahtar: 'fis.alan.projeKodu', ad: 'Proje Kodu', tur: 'metin', aktif: true });
    expect(res.body.fis).toContainEqual({ anahtar: 'fis.alan.projeKodu.ad', ad: 'Proje Kodu (açıklama)', tur: 'metin', aktif: true });
    expect(res.body.fis).toContainEqual({ anahtar: 'fis.genelToplam', ad: 'Genel Toplam', tur: 'tutar', aktif: true });
  });

  it('previews the body with sample values, or with a form as it is, without saving anything', async () => {
    const sample = await call(admin, 'POST', '/api/entegrasyonlar/onizle', { entegrasyon: { bicim: 'json', alanlar: [{ kaynak: 'form.tutar', alias: 'TTR' }] } });
    expect(sample.body).toEqual({ govde: '{\n  "TTR": 2193.39\n}', icerikTuru: 'application/json; charset=utf-8', ornek: true, form: null });

    const org = await makeOrganization(db, '1000', 'Örnek A.Ş.');
    const centre = await makeCostCenter(db, '11033106', 'Satış Ege');
    await assignDefinitions(db, worker.id, org, [centre]);
    await execute(db, `UPDATE dbo.masraf_kategorileri SET kod = N'YMK', hesap_kodu = N'7701001' WHERE id = 1`);
    const project = await makeOption(db, 'projeKodu', 'P34', 'Proje 34');
    const invoice = await makeInvoice(db, worker.id, { genelToplam: 1800, faturaNo: 'OKUNAN-1' });
    const second = await makeInvoice(db, worker.id, { genelToplam: 393.39, faturaNo: 'B-2' });
    const formId = await approvedForm({
      tutar: 2193.39,
      masrafMerkeziId: centre,
      faturaIdler: [invoice, second],
      faturaDuzeltmeleri: { [invoice]: sampleInvoice({ faturaNo: 'DUZ-1', saticiVergiNo: '1111111111' }) },
      fisAlanlari: { [invoice]: { projeKodu: project, not: 'Araç yıkama' } },
    });

    const entegrasyon = {
      // An unsaved editor: no name, no address; only what the body needs is checked.
      bicim: 'xml',
      kok: 'MT_Masraf',
      xmlAdAlani: 'urn:firma:masraf',
      tarihBicimi: 'YYYYAAGG',
      basliklar: [{ ad: 'Content-Type', deger: 'text/xml' }],
      alanlar: [
        { kaynak: 'form.no', alias: 'NO' },
        { kaynak: 'form.tutar', alias: 'TTR' },
        { kaynak: 'form.kategoriKodu', alias: 'KAT' },
        { kaynak: 'form.hesapKodu', alias: 'HKONT' },
        { kaynak: 'form.masrafMerkezi', alias: 'KOSTL' },
        { kaynak: 'form.organizasyon', alias: 'BUKRS' },
        { kaynak: 'form.gonderen', alias: 'AD' },
        { kaynak: 'form.departman', alias: 'DEP' },
        { kaynak: 'form.sonOnaylayan', alias: 'ONAY' },
        { kaynak: 'fis.sira', alias: 'SIRA' },
        { kaynak: 'fis.faturaNo', alias: 'BELNR' },
        { kaynak: 'fis.genelToplam', alias: 'WRBTR' },
        { kaynak: 'fis.faturaTarihi', alias: 'BLDAT' },
        { kaynak: 'fis.alan.projeKodu', alias: 'PROJE' },
        { kaynak: 'fis.alan.projeKodu.ad', alias: 'PROJE_AD' },
        { kaynak: 'fis.alan.not', alias: 'NOT' },
      ],
    };
    const res = await call(admin, 'POST', '/api/entegrasyonlar/onizle', { entegrasyon, formId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ icerikTuru: 'text/xml', ornek: false, form: { id: formId, baslik: 'Müşteri yemeği' } });
    expect(res.body.govde).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ns0:MT_Masraf xmlns:ns0="urn:firma:masraf">',
        `  <NO>${formId}</NO>`,
        '  <TTR>2193.39</TTR>',
        '  <KAT>YMK</KAT>',
        '  <HKONT>7701001</HKONT>',
        '  <KOSTL>11033106</KOSTL>',
        '  <BUKRS>1000</BUKRS>',
        '  <AD>Ayşe Kaya</AD>',
        '  <DEP>Satış</DEP>',
        '  <ONAY>Yönetici</ONAY>',
        '  <FISLER>',
        '    <FIS>',
        '      <SIRA>1</SIRA>',
        // The invoice's effective data: the correction.
        '      <BELNR>DUZ-1</BELNR>',
        '      <WRBTR>1800.00</WRBTR>',
        '      <BLDAT>20261105</BLDAT>',
        '      <PROJE>P34</PROJE>',
        '      <PROJE_AD>Proje 34</PROJE_AD>',
        '      <NOT>Araç yıkama</NOT>',
        '    </FIS>',
        '    <FIS>',
        '      <SIRA>2</SIRA>',
        '      <BELNR>B-2</BELNR>',
        '      <WRBTR>393.39</WRBTR>',
        '      <BLDAT>20261105</BLDAT>',
        '      <PROJE/>',
        '      <PROJE_AD/>',
        '      <NOT/>',
        '    </FIS>',
        '  </FISLER>',
        '</ns0:MT_Masraf>',
      ].join('\n'),
    );
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.entegrasyonlar')).toEqual({ n: 0 });

    expectError(await call(admin, 'POST', '/api/entegrasyonlar/onizle', { entegrasyon, formId: 999_999 }), 404, 'bulunamadi');
    expectError(
      await call(admin, 'POST', '/api/entegrasyonlar/onizle', { entegrasyon: { bicim: 'json', alanlar: [{ kaynak: 'form.tutar', alias: '1TTR' }] } }),
      400,
      'gecersiz_istek',
      { 'entegrasyon.alanlar.0.alias': 'Ad harf ya da _ ile başlamalı; yalnızca İngilizce harf, rakam, _, - ve . içermeli.' },
    );
  });

  it('queues a send for the active integrations of the trigger: the last approval, or the payment', async () => {
    const add = async (ad: string, tetikleyici: string, aktif = true) =>
      (await call(admin, 'POST', '/api/entegrasyonlar', integration({ ad, tetikleyici, aktif }))).body.id as number;
    const onApproval = await add('Onayda', 'onaylandi');
    const onPayment = await add('Ödemede', 'odendi');
    await add('Elle', 'elle');
    await add('Pasif', 'onaylandi', false);

    // Sent but not approved yet: nothing.
    const sent = await svc.create(worker, form(), true);
    expect(await sends()).toEqual([]);
    await svc.approve(sent.id, admin, null);
    expect(await sends()).toEqual([{ entegrasyon_id: onApproval, form_id: sent.id, tetikleyen: 'onaylandi', durum: 'bekliyor' }]);
    await svc.markPaid(sent.id, accounting);
    expect(await sends()).toEqual([
      { entegrasyon_id: onApproval, form_id: sent.id, tetikleyen: 'onaylandi', durum: 'bekliyor' },
      { entegrasyon_id: onPayment, form_id: sent.id, tetikleyen: 'odendi', durum: 'bekliyor' },
    ]);
    // A rejected form sends nothing.
    const rejected = await svc.create(worker, form(), true);
    await svc.reject(rejected.id, admin, 'Fiş eksik');
    expect(await sends()).toHaveLength(2);
    const listed = await call(admin, 'GET', `/api/entegrasyonlar/${onApproval}`);
    expect(listed.body.sonGonderim).toEqual({ id: expect.any(Number), durum: 'bekliyor', zaman: expect.any(String) });
  });

  it('sends an approved or paid form by hand, logs it, and retries only a failed send', async () => {
    const id = (await call(admin, 'POST', '/api/entegrasyonlar', integration({ tetikleyici: 'elle', aktif: false }))).body.id as number;
    const draft = await svc.create(worker, form(), false);
    expectError(await call(admin, 'POST', `/api/entegrasyonlar/${id}/gonder`, { formId: draft.id }), 409, 'gecersiz_durum');
    expectError(await call(admin, 'POST', `/api/entegrasyonlar/${id}/gonder`, { formId: 999_999 }), 404, 'bulunamadi');
    expectError(await call(admin, 'POST', `/api/entegrasyonlar/999999/gonder`, { formId: draft.id }), 404, 'bulunamadi');
    expect(kick).not.toHaveBeenCalled();

    const formId = await approvedForm();
    const queued = await call(admin, 'POST', `/api/entegrasyonlar/${id}/gonder`, { formId });
    expect(queued.status).toBe(202);
    expect(kick).toHaveBeenCalledTimes(1);
    const sendId = queued.body.id as number;

    const summary = {
      id: sendId,
      entegrasyon: { id, ad: 'SAP PI masraf' },
      form: { id: formId, baslik: 'Müşteri yemeği' },
      tetikleyen: 'elle',
      kullanici: { id: admin.id, adSoyad: 'Yönetici' },
      durum: 'bekliyor',
      deneme: 0,
      httpDurum: null,
      sonHata: null,
      olusturma: expect.any(String),
      gonderim: null,
      sonrakiDeneme: expect.any(String),
    };
    expect((await call(admin, 'GET', '/api/entegrasyon-gonderimleri')).body).toEqual([summary]);
    expect((await call(admin, 'GET', `/api/entegrasyon-gonderimleri?entegrasyonId=${id}&formId=${formId}&durum=bekliyor`)).body).toHaveLength(1);
    expect((await call(admin, 'GET', '/api/entegrasyon-gonderimleri?durum=hata')).body).toEqual([]);
    expect((await call(admin, 'GET', `/api/entegrasyon-gonderimleri/${sendId}`)).body).toEqual({ ...summary, govde: null, icerikTuru: null, yanit: null });
    expectError(await call(admin, 'GET', '/api/entegrasyon-gonderimleri?durum=atlandi'), 400, 'gecersiz_istek');

    expectError(await call(admin, 'POST', `/api/entegrasyon-gonderimleri/${sendId}/yeniden`), 409, 'gecersiz_durum');
    await execute(db, `UPDATE dbo.entegrasyon_gonderimleri SET durum = 'hata', deneme = 5, son_hata = N'HTTP 500', sonraki_deneme = NULL WHERE id = @i`, { i: p.int(sendId) });
    expect((await call(admin, 'POST', `/api/entegrasyon-gonderimleri/${sendId}/yeniden`)).status).toBe(202);
    expect(kick).toHaveBeenCalledTimes(2);
    expect((await call(admin, 'GET', `/api/entegrasyon-gonderimleri/${sendId}`)).body).toMatchObject({ durum: 'bekliyor', deneme: 0, sonHata: null });
    const log = await query<{ islem: string }>(db, `SELECT islem FROM dbo.denetim_kayitlari WHERE islem LIKE 'entegrasyon%' ORDER BY id`);
    expect(log.map((l) => l.islem)).toEqual(['entegrasyon_ekle', 'entegrasyon_gonder', 'entegrasyon_yeniden']);
  });

  it('shows a mapping row whose receipt field was deleted, and deletes an integration with its log', async () => {
    const extra = await call(admin, 'POST', '/api/alanlar', { ad: 'Araç Plakası', tur: 'metin' });
    expect(extra.status).toBe(201);
    const id = (
      await call(admin, 'POST', '/api/entegrasyonlar', integration({ alanlar: [{ kaynak: 'form.tutar', alias: 'TTR' }, { kaynak: 'fis.alan.aracPlakasi', alias: 'PLAKA' }] }))
    ).body.id as number;
    expect((await call(admin, 'DELETE', `/api/alanlar/${await fieldId(db, 'aracPlakasi')}`)).status).toBe(204);
    expect((await call(admin, 'GET', `/api/entegrasyonlar/${id}`)).body.sorunlar).toEqual(['2. satır (fis.alan.aracPlakasi): bu alan silinmiş.']);

    await approvedForm();
    expect(await sends()).toHaveLength(1);
    expect((await call(admin, 'DELETE', `/api/entegrasyonlar/${id}`)).status).toBe(204);
    expect(await sends()).toEqual([]);
    expectError(await call(admin, 'GET', `/api/entegrasyonlar/${id}`), 404, 'bulunamadi');
    expectError(await call(admin, 'DELETE', `/api/entegrasyonlar/${id}`), 404, 'bulunamadi');
  });
});
