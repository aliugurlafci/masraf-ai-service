// Receipt fields and their rules over HTTP (docs/onay-sistemi.md, section 3, "Fiş alanları, masraf merkezi
// ve zorunluluk kuralları", and section 6, "Fiş alanları" and "Masraf formları"). The required-field rules
// themselves are tested in tests/expenses/field-rules.test.ts and tests/expenses/receipt-fields.test.ts;
// this file checks what clients see: roles, shapes, status codes and error fields.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.ts';
import type { ExtractInvoice } from '../../src/claude/extractor.ts';
import { p, query, queryOne, type Db } from '../../src/db/sql.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { sampleExtraction } from '../helpers.ts';
import {
  assignDefinitions,
  chainOf,
  closeTestDb,
  fieldId,
  makeCostCenter,
  makeInvoice,
  makeOption,
  optionId,
  makeUser,
  resetDb,
  setFlow,
  testDb,
  tokenFor,
} from '../db.ts';

interface Answer {
  readonly status: number;
  readonly body: any;
}

const PAST = '2025-06-15';
const ENTRY_FIELDS = 7; // etiket, projeKodu, odemeYontemi, dokumanTipi, kkegTuru, vergiDairesi, not

describe('receipt field API', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let admin: Kullanici;
  let accounting: Kullanici;
  let worker: Kullanici;
  const tokens = new Map<number, string>();

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);

  beforeEach(async () => {
    await resetDb(db);
    admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    accounting = await makeUser(db, { rol: 'muhasebe', adSoyad: 'Muhasebe' });
    worker = await makeUser(db, { adSoyad: 'Çalışan' });
    tokens.clear();
    for (const u of [admin, accounting, worker]) tokens.set(u.id, await tokenFor(db, u.id));
    await setFlow(db, chainOf(admin.id));

    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    server.on('request', createApp({ extract, db, maxFileBytes: 1024 * 1024, port, log: () => {} }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = async (who: Kullanici, method: string, path: string, body?: unknown): Promise<Answer> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokens.get(who.id) ?? ''}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  };
  const expectError = (res: Answer, status: number, kod: string, alanlar?: Record<string, unknown>): void => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body).toMatchObject({ hata: { kod, mesaj: expect.any(String), ...(alanlar === undefined ? {} : { alanlar }) } });
  };
  const fields = async (who: Kullanici, all = false): Promise<{ alanlar: any[]; kurallar: any[] }> => {
    const res = await call(who, 'GET', `/api/alanlar${all ? '?tumu=1' : ''}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const field = async (anahtar: string): Promise<any> => (await fields(admin, true)).alanlar.find((a) => a.anahtar === anahtar);
  const newField = (ad: string, tur = 'metin', over: Record<string, unknown> = {}): Promise<Answer> => call(admin, 'POST', '/api/alanlar', { ad, tur, ...over });
  const newRule = (kosulAlan: string, kosulDegerId: number, hedefler: string[]): Promise<Answer> =>
    call(admin, 'POST', '/api/alan-kurallari', { kosulAlan, kosulDegerId, hedefler });
  const categoryName = async (id: number): Promise<string> =>
    (await queryOne<{ ad: string }>(db, 'SELECT ad FROM dbo.masraf_kategorileri WHERE id = @id', { id: p.int(id) }))?.ad ?? '';

  describe('GET /api/alanlar', () => {
    it('gives everyone the active fields and rules, and the admin everything with usage counts', async () => {
      const list = await fields(worker);
      expect(list.alanlar[0]).toEqual({
        id: await fieldId(db, 'kategori'),
        anahtar: 'kategori',
        ad: 'Kategori',
        duzey: 'form',
        tur: 'kategori',
        zorunlu: true,
        aktif: true,
        sira: 1,
        sistem: true,
        aciklama: null,
        secenekSayisi: null,
      });
      expect(list.alanlar.map((a) => a.anahtar).slice(0, 4)).toEqual(['kategori', 'masrafMerkezi', 'faturaNo', 'faturaTarihi']);
      expect(list.alanlar.find((a) => a.anahtar === 'dokumanTipi')).toMatchObject({ tur: 'liste', secenekSayisi: 6 });
      expect(list.kurallar).toEqual([]);

      // Rules, then a field and a rule's condition turned off.
      await call(admin, 'PATCH', `/api/alanlar/${await fieldId(db, 'etiket')}`, { aktif: false });
      const both = (await newRule('kategori', 1, ['etiket', 'projeKodu'])).body;
      await newRule('kategori', 2, ['etiket']);
      const invoiceType = await optionId(db, 'dokumanTipi', 'Fatura');
      await newRule('dokumanTipi', invoiceType, ['saticiVergiNo']);
      await call(admin, 'PATCH', `/api/alanlar/${await fieldId(db, 'dokumanTipi')}`, { aktif: false });

      for (const who of [worker, accounting]) {
        for (const all of [false, true]) {
          const seen = await fields(who, all);
          expect(seen.alanlar.every((a) => a.aktif === true && !('kullanim' in a))).toBe(true);
          expect(seen.alanlar.map((a) => a.anahtar)).not.toContain('etiket');
          expect(seen.kurallar).toEqual([{ ...both, hedefler: ['projeKodu'] }]);
        }
      }

      // Usage counts the receipts with a value, on forms and on files still being read.
      const inv = await makeInvoice(db, worker.id);
      const made = await call(worker, 'POST', '/api/masraflar', { baslik: 'Yol', kategoriId: 1, masrafTarihi: PAST, faturaIdler: [inv], fisAlanlari: { [inv]: { not: 'Not' } } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const everything = await fields(admin, true);
      expect(everything.alanlar.length).toBe(19);
      expect(everything.alanlar.find((a) => a.anahtar === 'etiket')).toMatchObject({ aktif: false, kullanim: 0 });
      expect(everything.alanlar.find((a) => a.anahtar === 'not')).toMatchObject({ kullanim: 1 });
      expect(everything.kurallar.map((k: any) => [k.kosulAlan, k.hedefler])).toEqual([
        ['kategori', ['etiket', 'projeKodu']],
        ['kategori', ['etiket']],
        ['dokumanTipi', ['saticiVergiNo']],
      ]);
      // Without tumu the admin sees what everyone sees.
      expect((await fields(admin)).kurallar).toHaveLength(1);
    });
  });

  describe('fields', () => {
    it('lets only the admin add, change and delete fields', async () => {
      const etiket = await fieldId(db, 'etiket');
      for (const who of [worker, accounting]) {
        expectError(await call(who, 'POST', '/api/alanlar', { ad: 'Plaka', tur: 'metin' }), 403, 'yetki_yok');
        expectError(await call(who, 'PATCH', `/api/alanlar/${etiket}`, { zorunlu: true }), 403, 'yetki_yok');
        expectError(await call(who, 'DELETE', `/api/alanlar/${etiket}`), 403, 'yetki_yok');
      }
    });

    it('creates a field with a key made from its name and a unique name', async () => {
      const made = await newField('Araç Plakası', 'metin', { zorunlu: true, aciklama: 'Aracın plakası' });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body).toEqual({
        id: expect.any(Number),
        anahtar: 'aracPlakasi',
        ad: 'Araç Plakası',
        duzey: 'fis',
        tur: 'metin',
        zorunlu: true,
        aktif: true,
        sira: 18,
        sistem: false,
        aciklama: 'Aracın plakası',
        secenekSayisi: null,
      });
      expectError(await newField('ARAÇ PLAKASI'), 409, 'alan_adi_kullaniliyor');
      expect((await newField('Araç-Plakası')).body).toMatchObject({ anahtar: 'aracPlakasi2', sira: 19 });
      expect((await newField('2. Sürücü', 'liste')).body).toMatchObject({ anahtar: 'alan2Surucu', secenekSayisi: 0 });

      expectError(await newField('Kategori 2', 'kategori'), 400, 'gecersiz_istek', { tur: expect.any(String) });
      expectError(await newField('Tutar 2', 'fatura'), 400, 'gecersiz_istek', { tur: expect.any(String) });
      expectError(await newField('', 'metin'), 400, 'gecersiz_istek', { ad: expect.any(String) });
      expectError(await newField('x'.repeat(61), 'metin'), 400, 'gecersiz_istek', { ad: expect.any(String) });
      expectError(await call(admin, 'POST', '/api/alanlar', { ad: 'Fazla', tur: 'metin', anahtar: 'fazla' }), 400, 'gecersiz_istek');
    });

    it('counts up to 40 receipt fields, inactive ones included', async () => {
      for (let i = 1; i <= 40 - ENTRY_FIELDS; i++) expect((await newField(`Alan ${i}`)).status).toBe(201);
      expectError(await newField('Bir fazlası'), 409, 'alan_siniri');
      const last = (await field('alan33')).id as number;
      await call(admin, 'PATCH', `/api/alanlar/${last}`, { aktif: false });
      expectError(await newField('Bir fazlası'), 409, 'alan_siniri');
      expect((await call(admin, 'DELETE', `/api/alanlar/${last}`)).status).toBe(204);
      expect((await newField('Bir fazlası')).status).toBe(201);
    });

    it("changes what a field allows, and refuses the properties that are fixed with the property's name", async () => {
      const etiket = await fieldId(db, 'etiket');
      const changed = await call(admin, 'PATCH', `/api/alanlar/${etiket}`, { ad: 'Masraf Etiketi', zorunlu: true, sira: 30, aciklama: 'SAP etiketi' });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body).toMatchObject({ id: etiket, anahtar: 'etiket', ad: 'Masraf Etiketi', zorunlu: true, aktif: true, sira: 30, aciklama: 'SAP etiketi' });
      expect((await call(admin, 'PATCH', `/api/alanlar/${etiket}`, { aciklama: null })).body.aciklama).toBeNull();
      expectError(await call(admin, 'PATCH', `/api/alanlar/${etiket}`, { ad: 'proje kodu' }), 409, 'alan_adi_kullaniliyor');
      expectError(await call(admin, 'PATCH', `/api/alanlar/${etiket}`, { tur: 'metin' }), 400, 'gecersiz_istek', { tur: 'Bu alanın türü değiştirilemez.' });
      expectError(await call(admin, 'PATCH', `/api/alanlar/${etiket}`, { anahtar: 'tag' }), 400, 'gecersiz_istek', { anahtar: 'Bu alanın anahtarı değiştirilemez.' });

      // System fields: only what section 3 allows.
      const faturaNo = await fieldId(db, 'faturaNo');
      expect((await call(admin, 'PATCH', `/api/alanlar/${faturaNo}`, { zorunlu: false, aciklama: 'Belge numarası' })).body).toMatchObject({ zorunlu: false, aciklama: 'Belge numarası' });
      // Sending a property unchanged is not a change.
      expect((await call(admin, 'PATCH', `/api/alanlar/${faturaNo}`, { ad: 'Fatura No', aktif: true })).status).toBe(200);
      expectError(await call(admin, 'PATCH', `/api/alanlar/${faturaNo}`, { ad: 'Belge No', aktif: false, sira: 5 }), 400, 'gecersiz_istek', {
        ad: 'Bu alanın adı değiştirilemez.',
        aktif: 'Bu alanın durumu değiştirilemez.',
        sira: 'Bu alanın sırası değiştirilemez.',
      });
      const kategori = await fieldId(db, 'kategori');
      expectError(await call(admin, 'PATCH', `/api/alanlar/${kategori}`, { zorunlu: false }), 400, 'gecersiz_istek', { zorunlu: 'Bu alanın zorunluluğu değiştirilemez.' });
      const mm = await fieldId(db, 'masrafMerkezi');
      expect((await call(admin, 'PATCH', `/api/alanlar/${mm}`, { zorunlu: true, aktif: false })).body).toMatchObject({ zorunlu: true, aktif: false });
      expectError(await call(admin, 'PATCH', `/api/alanlar/${mm}`, { ad: 'MM' }), 400, 'gecersiz_istek', { ad: expect.any(String) });
      expectError(await call(admin, 'PATCH', '/api/alanlar/999999', { zorunlu: true }), 404, 'bulunamadi');
    });

    it('deletes an unused field with its options and its place in rules, but not a system field or one in use', async () => {
      const plate = (await newField('Plaka', 'liste')).body.id as number;
      await makeOption(db, 'plaka', '34ABC12');
      const keptRule = (await newRule('kategori', 1, ['plaka', 'projeKodu'])).body.id as number;
      await newRule('kategori', 2, ['plaka']);
      await newRule('plaka', await optionId(db, 'plaka', '34ABC12'), ['etiket']);

      expectError(await call(admin, 'DELETE', `/api/alanlar/${await fieldId(db, 'faturaNo')}`), 409, 'sistem_alani');
      expectError(await call(admin, 'DELETE', `/api/alanlar/${await fieldId(db, 'masrafMerkezi')}`), 409, 'sistem_alani');
      const inv = await makeInvoice(db, worker.id);
      await call(worker, 'POST', '/api/masraflar', { baslik: 'Yol', kategoriId: 3, masrafTarihi: PAST, faturaIdler: [inv], fisAlanlari: { [inv]: { vergiDairesi: 'Kadıköy' } } });
      expectError(await call(admin, 'DELETE', `/api/alanlar/${await fieldId(db, 'vergiDairesi')}`), 409, 'alan_kullaniliyor');

      expect((await call(admin, 'DELETE', `/api/alanlar/${plate}`)).status).toBe(204);
      expect((await field('plaka'))).toBeUndefined();
      expect((await fields(admin, true)).kurallar).toEqual([expect.objectContaining({ id: keptRule, hedefler: ['projeKodu'] })]);
      expect(await query(db, 'SELECT id FROM dbo.alan_secenekleri WHERE alan_id = @a', { a: p.int(plate) })).toEqual([]);
      expectError(await call(admin, 'DELETE', `/api/alanlar/${plate}`), 404, 'bulunamadi');
    });
  });

  describe('rules', () => {
    it('lets only the admin write rules', async () => {
      for (const who of [worker, accounting]) {
        expectError(await call(who, 'POST', '/api/alan-kurallari', { kosulAlan: 'kategori', kosulDegerId: 1, hedefler: ['etiket'] }), 403, 'yetki_yok');
        expectError(await call(who, 'PUT', '/api/alan-kurallari/1', { kosulAlan: 'kategori', kosulDegerId: 1, hedefler: ['etiket'] }), 403, 'yetki_yok');
        expectError(await call(who, 'DELETE', '/api/alan-kurallari/1'), 403, 'yetki_yok');
      }
    });

    it('makes rules on a category, a cost centre or a list value, inactive values included', async () => {
      // Targets come back in field order: form fields first, then by sira.
      const onCategory = await newRule('kategori', 4, ['etiket', 'masrafMerkezi']);
      expect(onCategory.status, JSON.stringify(onCategory.body)).toBe(201);
      expect(onCategory.body).toEqual({
        id: expect.any(Number),
        kosulAlan: 'kategori',
        kosulDeger: { id: 4, gosterim: await categoryName(4), aktif: true },
        hedefler: ['masrafMerkezi', 'etiket'],
      });
      const mm = await makeCostCenter(db, '11033106', 'Merkez', false);
      expect((await newRule('masrafMerkezi', mm, ['projeKodu'])).body.kosulDeger).toEqual({ id: mm, gosterim: '11033106 – Merkez', aktif: false });
      const efatura = await optionId(db, 'dokumanTipi', 'e-Fatura');
      expect((await newRule('dokumanTipi', efatura, ['saticiVergiNo', 'aliciVergiNo'])).body).toMatchObject({
        kosulAlan: 'dokumanTipi',
        kosulDeger: { id: efatura, gosterim: 'e-Fatura', aktif: true },
        hedefler: ['saticiVergiNo', 'aliciVergiNo'],
      });
      expectError(await newRule('kategori', 4, ['projeKodu']), 409, 'kural_var');
    });

    it('names the part of a rule that is wrong', async () => {
      const cash = await optionId(db, 'odemeYontemi', 'Nakit');
      const kosulAlan = 'Koşul alanı kategori, masraf merkezi ya da liste türünde bir fiş alanı olmalıdır.';
      for (const key of ['faturaNo', 'vergiDairesi', 'yok']) {
        expectError(await newRule(key, 1, ['etiket']), 400, 'gecersiz_istek', { kosulAlan });
      }
      expectError(await newRule('kategori', 999_999, ['etiket']), 400, 'gecersiz_istek', { kosulDegerId: 'Bu kayıt koşul alanının listesinde yok.' });
      expectError(await newRule('dokumanTipi', cash, ['etiket']), 400, 'gecersiz_istek', { kosulDegerId: 'Bu kayıt koşul alanının listesinde yok.' });
      expectError(await newRule('masrafMerkezi', 999_999, ['etiket']), 400, 'gecersiz_istek', { kosulDegerId: expect.any(String) });

      expectError(await newRule('kategori', 1, ['etiket', 'kategori']), 400, 'gecersiz_istek', { 'hedefler.1': 'Kategori her zaman zorunludur; kuralın hedefi olamaz.' });
      expectError(await newRule('kategori', 1, ['yok']), 400, 'gecersiz_istek', { 'hedefler.0': 'Bu alan bulunamadı.' });
      expectError(await newRule('odemeYontemi', cash, ['odemeYontemi']), 400, 'gecersiz_istek', { 'hedefler.0': 'Alan kendi kuralının hedefi olamaz.' });
      expectError(await newRule('odemeYontemi', cash, ['etiket', 'masrafMerkezi']), 400, 'gecersiz_istek', {
        'hedefler.1': 'Fiş alanına bağlı bir kuralın hedefleri fiş alanı olmalıdır.',
      });
      expectError(await newRule('kategori', 1, ['etiket', 'etiket']), 400, 'gecersiz_istek', { 'hedefler.1': 'Aynı alan iki kez seçilmiş.' });
      expectError(await newRule('kategori', 1, []), 400, 'gecersiz_istek', { hedefler: expect.any(String) });
      expectError(await call(admin, 'POST', '/api/alan-kurallari', { kosulAlan: 'kategori', kosulDegerId: 1 }), 400, 'gecersiz_istek', { hedefler: expect.any(String) });
      expect((await fields(admin, true)).kurallar).toEqual([]);
    });

    it('replaces and deletes a rule', async () => {
      const first = (await newRule('kategori', 1, ['etiket'])).body.id as number;
      const second = (await newRule('kategori', 2, ['etiket'])).body.id as number;
      const replaced = await call(admin, 'PUT', `/api/alan-kurallari/${first}`, { kosulAlan: 'kategori', kosulDegerId: 3, hedefler: ['projeKodu', 'not'] });
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
      expect(replaced.body).toMatchObject({ id: first, kosulDeger: { id: 3 }, hedefler: ['projeKodu', 'not'] });
      // Keeping its own value is no clash; taking another rule's value is.
      expect((await call(admin, 'PUT', `/api/alan-kurallari/${first}`, { kosulAlan: 'kategori', kosulDegerId: 3, hedefler: ['not'] })).status).toBe(200);
      expectError(await call(admin, 'PUT', `/api/alan-kurallari/${first}`, { kosulAlan: 'kategori', kosulDegerId: 2, hedefler: ['not'] }), 409, 'kural_var');
      expectError(await call(admin, 'PUT', '/api/alan-kurallari/999999', { kosulAlan: 'kategori', kosulDegerId: 5, hedefler: ['not'] }), 404, 'bulunamadi');

      expect((await call(admin, 'DELETE', `/api/alan-kurallari/${second}`)).status).toBe(204);
      expectError(await call(admin, 'DELETE', `/api/alan-kurallari/${second}`), 404, 'bulunamadi');
      expect((await fields(admin, true)).kurallar.map((k: any) => k.id)).toEqual([first]);
    });
  });

  describe('receipt fields on forms', () => {
    it('takes the cost centre and the receipt values in the form body and refuses malformed ones', async () => {
      const mm = await makeCostCenter(db, '11033106', 'Merkez');
      await assignDefinitions(db, worker.id, null, [mm]);
      const tag = await makeOption(db, 'etiket', 'E1');
      const inv = await makeInvoice(db, worker.id);
      const body = { baslik: 'Yol', kategoriId: 1, masrafTarihi: PAST, tutar: 1800, faturaIdler: [inv] };
      const made = await call(worker, 'POST', '/api/masraflar', { ...body, masrafMerkeziId: mm, fisAlanlari: { [inv]: { etiket: tag } } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body.masrafMerkezi).toEqual({ id: mm, kod: '11033106', aciklama: 'Merkez', gosterim: '11033106 – Merkez', aktif: true });
      expect(made.body.faturalar[0]).toMatchObject({ alanlar: { etiket: { deger: tag, gosterim: 'E1' } }, eksikAlanlar: [] });
      const id = made.body.id as number;

      const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [String(1000 + i), {}]));
      expectError(await call(worker, 'PATCH', `/api/masraflar/${id}`, { fisAlanlari: { abc: {} } }), 400, 'gecersiz_istek', {
        'fisAlanlari.abc': 'Fiş anahtarı bir fatura kimliği ya da 64 karakterlik dosya özeti olmalıdır.',
      });
      expectError(await call(worker, 'PATCH', `/api/masraflar/${id}`, { fisAlanlari: tooMany }), 400, 'gecersiz_istek');
      expectError(await call(worker, 'PATCH', `/api/masraflar/${id}`, { fisAlanlari: { [inv]: 'E1' } }), 400, 'gecersiz_istek');
      expectError(await call(worker, 'PATCH', `/api/masraflar/${id}`, { masrafMerkeziId: 'x' }), 400, 'gecersiz_istek', { masrafMerkeziId: expect.any(String) });

      // A rule added afterwards stops the form at sending, naming each missing value.
      await newRule('kategori', 1, ['projeKodu']);
      const detail = await call(worker, 'GET', `/api/masraflar/${id}`);
      expect(detail.body.faturalar[0].eksikAlanlar).toEqual(['projeKodu']);
      expect(detail.body.eksikAlanlar).toEqual([]);
      expectError(await call(worker, 'POST', `/api/masraflar/${id}/gonder`, {}), 409, 'alan_eksik', { [`fisAlanlari.${inv}.projeKodu`]: 'Proje Kodu zorunlu.' });

      // The cost centre is checked the same way.
      await call(admin, 'PATCH', `/api/alanlar/${await fieldId(db, 'masrafMerkezi')}`, { zorunlu: true });
      const cleared = await call(worker, 'PATCH', `/api/masraflar/${id}`, { masrafMerkeziId: null, fisAlanlari: { [inv]: { etiket: tag, projeKodu: await makeOption(db, 'projeKodu', 'P1') } } });
      expect(cleared.body.eksikAlanlar).toEqual(['masrafMerkezi']);
      expectError(await call(worker, 'POST', `/api/masraflar/${id}/gonder`, {}), 409, 'alan_eksik', { masrafMerkeziId: 'Masraf merkezi seçilmeli.' });
      await call(worker, 'PATCH', `/api/masraflar/${id}`, { masrafMerkeziId: mm });
      const sent = await call(worker, 'POST', `/api/masraflar/${id}/gonder`, {});
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.durum).toBe('onayda');
    });
  });
});
