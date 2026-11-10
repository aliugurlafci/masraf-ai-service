// Definition lists over HTTP (docs/onay-sistemi.md, section 6, "Tanım listeleri", "Kategoriler" and
// "Kullanıcılar"): roles, records, paging, the 409s, Excel export and import, and the users' organisation
// and cost centres. Workbooks shaped like the masraff.io exports are built here with the writer; the
// user's real files never enter the repository.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.ts';
import type { ExtractInvoice } from '../../src/claude/extractor.ts';
import { listAudit } from '../../src/db/audit.ts';
import { execute, p, query, queryOne, type Db } from '../../src/db/sql.ts';
import { readXlsx, writeXlsx } from '../../src/excel/xlsx.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { sampleExtraction } from '../helpers.ts';
import { assignDefinitions, closeTestDb, fieldId, makeCostCenter, makeOption, makeOrganization, makeUser, resetDb, testDb, tokenFor } from '../db.ts';

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MB = 1024 * 1024;

/** A one-sheet workbook from a header and rows, as Excel or masraff.io would send it. */
const workbook = (header: string[], ...rows: string[][]): Buffer => writeXlsx({ name: 'Sayfa1', header, rows });

describe('definition lists API', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let admin: Kullanici;
  let accounting: Kullanici;
  let employee: Kullanici;
  const tokens = new Map<number, string>();
  const tokenOf = (u: Kullanici): string => tokens.get(u.id) ?? '';

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);

  beforeEach(async () => {
    await resetDb(db);
    admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    accounting = await makeUser(db, { rol: 'muhasebe', adSoyad: 'Muhasebe' });
    employee = await makeUser(db, { adSoyad: 'Çalışan' });
    tokens.clear();
    for (const u of [admin, accounting, employee]) tokens.set(u.id, await tokenFor(db, u.id));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    server.on('request', createApp({ extract, db, maxFileBytes: MB, port, log: () => {} }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const answer = async (res: Response): Promise<Answer> => {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, body };
  };

  const call = async (who: Kullanici | null, method: string, path: string, body?: unknown): Promise<Answer> => {
    const headers: Record<string, string> = who === null ? {} : { Authorization: `Bearer ${tokenOf(who)}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return answer(await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  };

  /** Sends a file to an import route: raw (with a content type) or as the "dosya" field of a form. */
  const send = async (who: Kullanici, path: string, file: Buffer, how: 'raw' | 'octet' | 'multipart' = 'raw', field = 'dosya'): Promise<Answer> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokenOf(who)}` };
    let body: BodyInit;
    if (how === 'multipart') {
      const form = new FormData();
      form.append(field, new Blob([new Uint8Array(file)]), 'liste.xlsx');
      body = form;
    } else {
      headers['Content-Type'] = how === 'raw' ? XLSX : 'application/octet-stream';
      body = new Uint8Array(file);
    }
    return answer(await fetch(`${base}${path}`, { method: 'POST', headers, body }));
  };

  const download = async (who: Kullanici, path: string): Promise<{ status: number; headers: Headers; file: Buffer }> => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tokenOf(who)}` } });
    return { status: res.status, headers: res.headers, file: Buffer.from(await res.arrayBuffer()) };
  };

  const expectError = (res: Answer, status: number, kod: string): void => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body).toMatchObject({ hata: { kod, mesaj: expect.any(String) } });
  };

  const fieldError = (res: Answer, alan: string): void => {
    expectError(res, 400, 'gecersiz_istek');
    expect(Object.keys(res.body.hata.alanlar ?? {}), JSON.stringify(res.body)).toContain(alan);
  };

  /** A draft form of `owner`, written directly: what makes a category, cost centre or organisation "used". */
  const draftForm = async (owner: Kullanici, refs: { kategoriId?: number; masrafMerkeziId?: number | null; organizasyonId?: number | null } = {}): Promise<number> => {
    const row = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, para_birimi, durum, masraf_merkezi_id, organizasyon_id)
       OUTPUT inserted.id VALUES (@o, N'Taslak', @k, '2025-06-15', 'TRY', 'taslak', @m, @org)`,
      { o: p.int(owner.id), k: p.int(refs.kategoriId ?? 1), m: p.int(refs.masrafMerkeziId ?? null), org: p.int(refs.organizasyonId ?? null) },
    );
    return row?.id ?? 0;
  };

  /** A file waiting on a form with an option chosen for one of its fields. */
  const chooseOption = async (owner: Kullanici, anahtar: string, secenekId: number): Promise<void> => {
    const formId = await draftForm(owner);
    const pending = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.bekleyen_faturalar (form_id, kullanici_id, dosya_adi, dosya_ozeti, mime, boyut, icerik)
       OUTPUT inserted.id VALUES (@f, @u, N'fis.jpg', REPLICATE('a', 64), 'image/jpeg', 3, 0x010203)`,
      { f: p.int(formId), u: p.int(owner.id) },
    );
    await execute(db, 'INSERT INTO dbo.bekleyen_alan_degerleri (bekleyen_id, alan_id, secenek_id) VALUES (@b, @a, @s)', {
      b: p.int(pending?.id ?? 0),
      a: p.int(await fieldId(db, anahtar)),
      s: p.int(secenekId),
    });
  };

  /** A rule "when <field> is <value>, <targets> are required", written directly. */
  const makeRule = async (kosul: string, deger: number, hedefler: string[]): Promise<number> => {
    const row = await queryOne<{ id: number }>(db, 'INSERT INTO dbo.alan_kurallari (kosul_alan_id, kosul_deger_id) OUTPUT inserted.id VALUES (@a, @d)', {
      a: p.int(await fieldId(db, kosul)),
      d: p.int(deger),
    });
    for (const h of hedefler) await execute(db, 'INSERT INTO dbo.alan_kurali_hedefleri (kural_id, alan_id) VALUES (@k, @a)', { k: p.int(row?.id ?? 0), a: p.int(await fieldId(db, h)) });
    return row?.id ?? 0;
  };
  const ruleCount = async (): Promise<number> => (await queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM dbo.alan_kurallari'))?.n ?? 0;

  describe('roles', () => {
    it('keeps the lists, their Excel files and the category delete for administrators', async () => {
      const org = await makeOrganization(db, '1000');
      const cc = await makeCostCenter(db, '11033106');
      const option = await makeOption(db, 'etiket', 'E1');
      const file = workbook(['Kod'], ['X']);
      const requests: Array<[string, string, unknown?]> = [
        ['GET', '/api/organizasyonlar'],
        ['POST', '/api/organizasyonlar', { kod: '2000', ad: 'İkinci' }],
        ['PATCH', `/api/organizasyonlar/${org}`, { aktif: false }],
        ['DELETE', `/api/organizasyonlar/${org}`],
        ['GET', '/api/organizasyonlar/disa-aktar'],
        ['GET', '/api/masraf-merkezleri'],
        ['POST', '/api/masraf-merkezleri', { kod: 'X' }],
        ['PATCH', `/api/masraf-merkezleri/${cc}`, { aktif: false }],
        ['DELETE', `/api/masraf-merkezleri/${cc}`],
        ['GET', '/api/masraf-merkezleri/disa-aktar'],
        ['POST', '/api/alanlar/etiket/secenekler', { kod: 'X' }],
        ['PATCH', `/api/alanlar/etiket/secenekler/${option}`, { aktif: false }],
        ['DELETE', `/api/alanlar/etiket/secenekler/${option}`],
        ['GET', '/api/alanlar/etiket/secenekler/disa-aktar'],
        ['DELETE', '/api/kategoriler/9'],
        ['GET', '/api/kategoriler/disa-aktar'],
      ];
      for (const who of [employee, accounting]) {
        for (const [method, path, body] of requests) expectError(await call(who, method, path, body), 403, 'yetki_yok');
        for (const path of ['/api/organizasyonlar', '/api/masraf-merkezleri', '/api/kategoriler', '/api/alanlar/etiket/secenekler']) {
          expectError(await send(who, `${path}/ice-aktar`, file), 403, 'yetki_yok');
        }
      }
      expectError(await call(null, 'GET', '/api/organizasyonlar'), 401, 'oturum_gerekli');
      expectError(await call(null, 'GET', '/api/alanlar/etiket/secenekler'), 401, 'oturum_gerekli');
      // Nothing changed.
      expect((await call(admin, 'GET', '/api/organizasyonlar')).body.toplam).toBe(1);
      expect(await ruleCount()).toBe(0);
    });
  });

  describe('organisations', () => {
    it('creates, edits and deletes an organisation, writing each step to the audit log', async () => {
      const created = await call(admin, 'POST', '/api/organizasyonlar', { kod: ' 1000 ', ad: ' Şenpiliç Gıda Sanayi A.Ş. ', paraBirimi: 'try' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toEqual({ id: expect.any(Number), kod: '1000', ad: 'Şenpiliç Gıda Sanayi A.Ş.', paraBirimi: 'TRY', aktif: true, kullaniciSayisi: 0 });
      expect(created.headers.get('location')).toBe(`/api/organizasyonlar/${created.body.id}`);
      const id = created.body.id as number;

      const edited = await call(admin, 'PATCH', `/api/organizasyonlar/${id}`, { ad: 'Şenpiliç', paraBirimi: null, aktif: false });
      expect(edited.body).toEqual({ id, kod: '1000', ad: 'Şenpiliç', paraBirimi: null, aktif: false, kullaniciSayisi: 0 });
      expect((await call(admin, 'PATCH', `/api/organizasyonlar/${id}`, { paraBirimi: '' })).body.paraBirimi).toBeNull();

      expect((await call(admin, 'DELETE', `/api/organizasyonlar/${id}`)).status).toBe(204);
      expectError(await call(admin, 'DELETE', `/api/organizasyonlar/${id}`), 404, 'bulunamadi');
      expectError(await call(admin, 'PATCH', `/api/organizasyonlar/${id}`, { ad: 'Yok' }), 404, 'bulunamadi');
      expectError(await call(admin, 'PATCH', '/api/organizasyonlar/abc', { ad: 'Yok' }), 404, 'bulunamadi');

      const log = (await listAudit(db, 10)).map((a) => [a.islem, a.ayrinti]);
      expect(log).toEqual([
        ['organizasyon_silindi', '1000 – Şenpiliç'],
        ['organizasyon_guncellendi', '1000 – Şenpiliç Gıda Sanayi A.Ş.: ad Şenpiliç Gıda Sanayi A.Ş. → Şenpiliç, para birimi TRY → -, pasifleştirildi'],
        ['organizasyon_olusturuldu', '1000 – Şenpiliç Gıda Sanayi A.Ş.'],
      ]);
    });

    it('checks the fields of an organisation', async () => {
      fieldError(await call(admin, 'POST', '/api/organizasyonlar', { kod: '1000' }), 'ad');
      fieldError(await call(admin, 'POST', '/api/organizasyonlar', { kod: '', ad: 'A' }), 'kod');
      fieldError(await call(admin, 'POST', '/api/organizasyonlar', { kod: 'K'.repeat(51), ad: 'A' }), 'kod');
      fieldError(await call(admin, 'POST', '/api/organizasyonlar', { kod: '1', ad: 'A'.repeat(201) }), 'ad');
      fieldError(await call(admin, 'POST', '/api/organizasyonlar', { kod: '1', ad: 'A', paraBirimi: 'TL' }), 'paraBirimi');
      const id = await makeOrganization(db, '1000');
      fieldError(await call(admin, 'PATCH', `/api/organizasyonlar/${id}`, { sira: 3 }), '_');
      fieldError(await call(admin, 'PATCH', `/api/organizasyonlar/${id}`, { aktif: 'evet' }), 'aktif');
    });

    it('keeps codes unique without case, by Turkish rules', async () => {
      await call(admin, 'POST', '/api/organizasyonlar', { kod: 'istanbul', ad: 'İstanbul şubesi' });
      expectError(await call(admin, 'POST', '/api/organizasyonlar', { kod: 'İSTANBUL', ad: 'Aynı' }), 409, 'kod_kullaniliyor');
      // In Turkish, I is the capital of ı, not of i.
      expect((await call(admin, 'POST', '/api/organizasyonlar', { kod: 'ISTANBUL', ad: 'Başka' })).status).toBe(201);
      const other = await call(admin, 'POST', '/api/organizasyonlar', { kod: '2000', ad: 'İkinci' });
      expectError(await call(admin, 'PATCH', `/api/organizasyonlar/${other.body.id}`, { kod: 'İstanbul' }), 409, 'kod_kullaniliyor');
    });

    it('counts the active users and refuses to delete one in use', async () => {
      const id = await makeOrganization(db, '1000');
      await assignDefinitions(db, employee.id, id);
      await assignDefinitions(db, (await makeUser(db, { aktif: false })).id, id);
      expect((await call(admin, 'GET', '/api/organizasyonlar')).body.kayitlar[0]).toMatchObject({ kod: '1000', kullaniciSayisi: 1 });
      expectError(await call(admin, 'DELETE', `/api/organizasyonlar/${id}`), 409, 'kullaniliyor');

      const onForm = await makeOrganization(db, '2000');
      await draftForm(admin, { organizasyonId: onForm });
      expectError(await call(admin, 'DELETE', `/api/organizasyonlar/${onForm}`), 409, 'kullaniliyor');
      // Deactivating is the way out.
      expect((await call(admin, 'PATCH', `/api/organizasyonlar/${onForm}`, { aktif: false })).body.aktif).toBe(false);
    });
  });

  describe('cost centres', () => {
    it('pages, searches and filters by code', async () => {
      for (const [kod, aciklama, aktif] of [
        ['11033106', '11033106', true],
        ['12043106', 'Satış İstanbul', true],
        ['13000001', null, false],
        ['14000002', 'Üretim', true],
        ['15000003', 'Satış Ankara', true],
        ['16000004', null, true],
        ['17000005', 'Kalite', false],
      ] as const) {
        await makeCostCenter(db, kod, aciklama, aktif);
      }
      const page = await call(admin, 'GET', '/api/masraf-merkezleri?adet=3&sayfa=2');
      expect(page.body).toMatchObject({ toplam: 7, sayfa: 2, adet: 3 });
      expect(page.body.kayitlar.map((m: any) => m.kod)).toEqual(['14000002', '15000003', '16000004']);
      expect(page.body.kayitlar[0]).toEqual({ id: expect.any(Number), kod: '14000002', aciklama: 'Üretim', gosterim: '14000002 – Üretim', aktif: true, kullaniciSayisi: 0 });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?sayfa=9')).body).toMatchObject({ kayitlar: [], toplam: 7, sayfa: 9, adet: 50 });

      const search = await call(admin, 'GET', `/api/masraf-merkezleri?q=${encodeURIComponent('satış')}`);
      expect(search.body.kayitlar.map((m: any) => m.kod)).toEqual(['12043106', '15000003']);
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?q=1103')).body.kayitlar.map((m: any) => m.gosterim)).toEqual(['11033106']);
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?q=%25')).body.toplam).toBe(0);
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?aktif=0')).body.kayitlar.map((m: any) => m.kod)).toEqual(['13000001', '17000005']);
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?aktif=true&q=satış')).body.toplam).toBe(2);

      fieldError(await call(admin, 'GET', '/api/masraf-merkezleri?adet=201'), 'adet');
      fieldError(await call(admin, 'GET', '/api/masraf-merkezleri?sayfa=0'), 'sayfa');
      fieldError(await call(admin, 'GET', '/api/masraf-merkezleri?aktif=belki'), 'aktif');
    });

    it('creates and edits a cost centre; an empty description is null', async () => {
      const created = await call(admin, 'POST', '/api/masraf-merkezleri', { kod: '11033106', aciklama: '' });
      expect(created.body).toEqual({ id: expect.any(Number), kod: '11033106', aciklama: null, gosterim: '11033106', aktif: true, kullaniciSayisi: 0 });
      const edited = await call(admin, 'PATCH', `/api/masraf-merkezleri/${created.body.id}`, { aciklama: 'Merkez ofis' });
      expect(edited.body.gosterim).toBe('11033106 – Merkez ofis');
      await call(admin, 'POST', '/api/masraf-merkezleri', { kod: 'MM-2' });
      expectError(await call(admin, 'POST', '/api/masraf-merkezleri', { kod: 'mm-2' }), 409, 'kod_kullaniliyor');
      fieldError(await call(admin, 'POST', '/api/masraf-merkezleri', { kod: 'X', aciklama: 'A'.repeat(201) }), 'aciklama');
    });

    it('refuses to delete one assigned or chosen, and deletes the rules whose condition it is', async () => {
      const assigned = await makeCostCenter(db, 'ATANMIS');
      await assignDefinitions(db, employee.id, null, [assigned]);
      expectError(await call(admin, 'DELETE', `/api/masraf-merkezleri/${assigned}`), 409, 'kullaniliyor');
      const chosen = await makeCostCenter(db, 'SECILI');
      await draftForm(admin, { masrafMerkeziId: chosen });
      expectError(await call(admin, 'DELETE', `/api/masraf-merkezleri/${chosen}`), 409, 'kullaniliyor');

      const free = await makeCostCenter(db, 'SERBEST');
      await makeRule('masrafMerkezi', free, ['etiket', 'projeKodu']);
      const kept = await makeRule('masrafMerkezi', assigned, ['etiket']);
      // A category with the same id as a condition value of another field stays.
      await makeRule('kategori', free, ['etiket']);
      expect((await call(admin, 'DELETE', `/api/masraf-merkezleri/${free}`)).status).toBe(204);
      expect(await query(db, 'SELECT id FROM dbo.alan_kurallari ORDER BY id')).toHaveLength(2);
      expect(await queryOne(db, 'SELECT id FROM dbo.alan_kurallari WHERE id = @k', { k: p.int(kept) })).not.toBeNull();
      expect(await queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM dbo.alan_kurali_hedefleri')).toEqual({ n: 2 });
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'masraf_merkezi_silindi', ayrinti: 'SERBEST (1 zorunluluk kuralı da silindi)' });
    });
  });

  describe('options of a list field', () => {
    it('shows everyone the active options of an active field, by order and code', async () => {
      await makeOption(db, 'etiket', 'B-2', 'İkinci');
      await makeOption(db, 'etiket', 'A-1', 'A-1');
      await makeOption(db, 'etiket', 'C-3', null, false);
      const mine = await call(employee, 'GET', '/api/alanlar/etiket/secenekler?aktif=0');
      expect(mine.body).toEqual({
        kayitlar: [
          { id: expect.any(Number), kod: 'A-1', ad: 'A-1', gosterim: 'A-1', aktif: true, sira: 0 },
          { id: expect.any(Number), kod: 'B-2', ad: 'İkinci', gosterim: 'B-2 – İkinci', aktif: true, sira: 0 },
        ],
        toplam: 2,
        sayfa: 1,
        adet: 50,
      });
      expect((await call(admin, 'GET', '/api/alanlar/etiket/secenekler')).body.toplam).toBe(3);
      expect((await call(admin, 'GET', '/api/alanlar/etiket/secenekler?aktif=0')).body.kayitlar.map((s: any) => s.kod)).toEqual(['C-3']);
      expect((await call(employee, 'GET', '/api/alanlar/odemeYontemi/secenekler')).body.kayitlar.map((s: any) => s.kod)).toEqual(['Nakit', 'Kredi Kartı', 'Şirket Kartı', 'Banka Havalesi']);
      expect((await call(employee, 'GET', `/api/alanlar/etiket/secenekler?q=${encodeURIComponent('ikinci')}`)).body.toplam).toBe(1);

      await execute(db, `UPDATE dbo.alan_tanimlari SET aktif = 0 WHERE anahtar = 'etiket'`);
      expectError(await call(employee, 'GET', '/api/alanlar/etiket/secenekler'), 404, 'bulunamadi');
      expect((await call(admin, 'GET', '/api/alanlar/etiket/secenekler')).status).toBe(200);
      for (const key of ['vergiDairesi', 'kategori', 'yok', 'etiket%27%3B--']) expectError(await call(admin, 'GET', `/api/alanlar/${key}/secenekler`), 404, 'bulunamadi');
    });

    it('adds options after the last one and edits order and state', async () => {
      const added = await call(admin, 'POST', '/api/alanlar/odemeYontemi/secenekler', { kod: 'Çek', ad: 'Banka çeki' });
      expect(added.status).toBe(201);
      expect(added.body).toEqual({ id: expect.any(Number), kod: 'Çek', ad: 'Banka çeki', gosterim: 'Çek – Banka çeki', aktif: true, sira: 5 });
      expect(added.headers.get('location')).toBe(`/api/alanlar/odemeYontemi/secenekler/${added.body.id}`);
      expectError(await call(admin, 'POST', '/api/alanlar/odemeYontemi/secenekler', { kod: 'NAKİT' }), 409, 'kod_kullaniliyor');
      // The same code in another field is fine.
      expect((await call(admin, 'POST', '/api/alanlar/dokumanTipi/secenekler', { kod: 'Çek' })).status).toBe(201);

      const edited = await call(admin, 'PATCH', `/api/alanlar/odemeYontemi/secenekler/${added.body.id}`, { sira: 0, aktif: false, ad: null });
      expect(edited.body).toMatchObject({ kod: 'Çek', ad: null, gosterim: 'Çek', aktif: false, sira: 0 });
      // An option is reached only through its own field.
      expectError(await call(admin, 'PATCH', `/api/alanlar/dokumanTipi/secenekler/${added.body.id}`, { aktif: true }), 404, 'bulunamadi');
      expectError(await call(admin, 'DELETE', `/api/alanlar/dokumanTipi/secenekler/${added.body.id}`), 404, 'bulunamadi');
      fieldError(await call(admin, 'PATCH', `/api/alanlar/odemeYontemi/secenekler/${added.body.id}`, { sira: -1 }), 'sira');
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'secenek_guncellendi', ayrinti: 'Ödeme Yöntemi: Çek – Banka çeki: ad Banka çeki → -, sıra 5 → 0, pasifleştirildi' });
    });

    it('refuses to delete a chosen option and deletes the rules whose condition it is', async () => {
      const chosen = await makeOption(db, 'etiket', 'SECILI');
      await chooseOption(employee, 'etiket', chosen);
      expectError(await call(admin, 'DELETE', `/api/alanlar/etiket/secenekler/${chosen}`), 409, 'kullaniliyor');

      const fatura = (await query<{ id: number }>(db, `SELECT s.id FROM dbo.alan_secenekleri s JOIN dbo.alan_tanimlari a ON a.id = s.alan_id WHERE a.anahtar = 'dokumanTipi' AND s.kod = N'Fatura'`))[0]?.id ?? 0;
      await makeRule('dokumanTipi', fatura, ['saticiVergiNo']);
      expect((await call(admin, 'DELETE', `/api/alanlar/dokumanTipi/secenekler/${fatura}`)).status).toBe(204);
      expect(await ruleCount()).toBe(0);
    });
  });

  describe('categories', () => {
    it('carries code, VAT rates and account code, and clears them with empty text', async () => {
      const created = await call(admin, 'POST', '/api/kategoriler', { ad: 'Araç bakım', simge: 'ulasim', kod: ' AB ', kdvOranlari: '0, 1, 10, 20', hesapKodu: '7609901001' });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ id: expect.any(Number), ad: 'Araç bakım', simge: 'ulasim', aktif: true, sira: 10, kod: 'AB', kdvOranlari: '0, 1, 10, 20', hesapKodu: '7609901001' });
      const edited = await call(admin, 'PATCH', `/api/kategoriler/${created.body.id}`, { kod: '', hesapKodu: null });
      expect(edited.body).toMatchObject({ kod: null, kdvOranlari: '0, 1, 10, 20', hesapKodu: null });
      expect((await call(employee, 'GET', '/api/kategoriler')).body[0]).toEqual({ id: 1, ad: 'Yemek', simge: 'yemek', aktif: true, sira: 1, kod: null, kdvOranlari: null, hesapKodu: null });
      fieldError(await call(admin, 'POST', '/api/kategoriler', { ad: 'X', kod: 'K'.repeat(51) }), 'kod');
      expectError(await call(admin, 'POST', '/api/kategoriler', { ad: 'YEMEK' }), 409, 'kategori_var');
    });

    it('deletes an unused category with the rules whose condition it is, and refuses a used one', async () => {
      await makeRule('kategori', 9, ['etiket', 'projeKodu']);
      expect((await call(admin, 'DELETE', '/api/kategoriler/9')).status).toBe(204);
      expect(await ruleCount()).toBe(0);
      expect((await call(admin, 'GET', '/api/kategoriler?tumu=1')).body.map((k: any) => k.id)).not.toContain(9);
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'kategori_silindi', ayrinti: 'Diğer (1 zorunluluk kuralı da silindi)' });

      await draftForm(employee, { kategoriId: 2 });
      expectError(await call(admin, 'DELETE', '/api/kategoriler/2'), 409, 'kullaniliyor');
      expectError(await call(admin, 'DELETE', '/api/kategoriler/999'), 404, 'bulunamadi');
    });
  });

  describe('Excel export', () => {
    it('downloads every record, inactive ones too, as text cells with Evet/Hayır', async () => {
      await makeOrganization(db, '2000', 'İkinci Şirket', false);
      await makeOrganization(db, '1000', 'Şenpiliç Gıda Sanayi A.Ş.');
      await execute(db, `UPDATE dbo.organizasyonlar SET para_birimi = 'TRY' WHERE kod = '1000'`);
      const res = await download(admin, '/api/organizasyonlar/disa-aktar');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(XLSX);
      const today = /_(\d{4}-\d{2}-\d{2})\.xlsx"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? '';
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Organizasyonlar_${today}.xlsx"; filename*=UTF-8''Organizasyonlar_${today}.xlsx`);
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(readXlsx(res.file).map((r) => r.hucreler)).toEqual([
        ['Organizasyon Kodu', 'Organizasyon Adı', 'Para Birimi', 'Aktif'],
        ['1000', 'Şenpiliç Gıda Sanayi A.Ş.', 'TRY', 'Evet'],
        ['2000', 'İkinci Şirket', '', 'Hayır'],
      ]);
    });

    it('names the file after the list and gives an ASCII fallback for Turkish names', async () => {
      const res = await download(admin, '/api/alanlar/odemeYontemi/secenekler/disa-aktar');
      const disposition = res.headers.get('content-disposition') ?? '';
      expect(disposition).toMatch(/^attachment; filename="Odeme Yontemi_\d{4}-\d{2}-\d{2}\.xlsx"; filename\*=UTF-8''%C3%96deme%20Y%C3%B6ntemi_\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(readXlsx(res.file).map((r) => r.hucreler)).toEqual([['Kod', 'Açıklama', 'Aktif'], ['Nakit', '', 'Evet'], ['Kredi Kartı', '', 'Evet'], ['Şirket Kartı', '', 'Evet'], ['Banka Havalesi', '', 'Evet']]);
      const cats = readXlsx((await download(admin, '/api/kategoriler/disa-aktar')).file);
      expect(cats[0]?.hucreler).toEqual(['Kategori Adı', 'Kategori Kodu', 'KDV Oranları', 'Hesap Kodu', 'Simge', 'Aktif']);
      expect(cats[1]?.hucreler).toEqual(['Yemek', '', '', '', 'yemek', 'Evet']);
      expect(readXlsx((await download(admin, '/api/masraf-merkezleri/disa-aktar')).file).map((r) => r.hucreler)).toEqual([['Masraf Merkezi', 'Açıklama', 'Aktif']]);
    });

    it('turns an export into an import that changes nothing, and an edited one into updates', async () => {
      await makeCostCenter(db, '11033106', '11033106');
      await makeCostCenter(db, '12043106', 'Satış', false);
      const exported = (await download(admin, '/api/masraf-merkezleri/disa-aktar')).file;
      const same = await send(admin, '/api/masraf-merkezleri/ice-aktar', exported);
      expect(same.body).toEqual({
        onizleme: false,
        satirSayisi: 2,
        eklenen: 0,
        guncellenen: 0,
        degismeyen: 2,
        pasiflestirilen: 0,
        hataSayisi: 0,
        hatalar: [],
        sutunlar: { kod: 'Masraf Merkezi', aciklama: 'Açıklama', aktif: 'Aktif' },
        yokSayilanSutunlar: [],
      });
      const rows = readXlsx(exported).map((r) => [...r.hucreler]);
      rows[2] = ['12043106', 'Satış ve pazarlama', 'Evet'];
      const [header = [], ...data] = rows;
      const edited = await send(admin, '/api/masraf-merkezleri/ice-aktar', workbook(header, ...data));
      expect(edited.body).toMatchObject({ guncellenen: 1, degismeyen: 1 });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?q=12043106')).body.kayitlar[0]).toMatchObject({ aciklama: 'Satış ve pazarlama', aktif: true });
    });

    it('serves an empty list as an import template', async () => {
      const template = readXlsx((await download(admin, '/api/organizasyonlar/disa-aktar')).file)[0]?.hucreler ?? [];
      const res = await send(admin, '/api/organizasyonlar/ice-aktar', workbook([...template], ['1000', 'Şenpiliç', 'try', ''], ['2000', 'İkinci', '', 'Hayır']));
      expect(res.body).toMatchObject({ eklenen: 2, hataSayisi: 0 });
      expect((await call(admin, 'GET', '/api/organizasyonlar')).body.kayitlar).toMatchObject([
        { kod: '1000', ad: 'Şenpiliç', paraBirimi: 'TRY', aktif: true },
        { kod: '2000', ad: 'İkinci', paraBirimi: null, aktif: false },
      ]);
    });
  });

  describe('Excel import', () => {
    const masraffCostCenters = (): Buffer =>
      workbook(
        ['MasrafMerkeziNo', 'ŞirketNo', 'MasrafMerkezi', 'Açıklama', 'GlKod', 'BirinciOnaycı'],
        ['1', '1000', '11033106', '11033106', '', 'onayci@firma.test'],
        ['2', '1000', ' 12043106', 'Satış', '', ''],
        ['3', '1000', '', 'Kodsuz', '', ''],
        ['4', '1000', '13000001', '', '', ''],
        ['5', '1000', '12043106', 'Satış', '', ''],
        ['6', '1000', '', '', '', 'onayci@firma.test'],
      );

    it('previews without writing, then applies the same file', async () => {
      const file = masraffCostCenters();
      const preview = await send(admin, '/api/masraf-merkezleri/ice-aktar?onizleme=1', file);
      const expected = {
        satirSayisi: 6,
        eklenen: 3,
        guncellenen: 0,
        degismeyen: 0,
        pasiflestirilen: 0,
        hataSayisi: 3,
        hatalar: [
          { satir: 4, mesaj: 'Kod boş.' },
          { satir: 6, mesaj: 'Bu kod dosyada 3. satırda da var.' },
          { satir: 7, mesaj: 'Kod boş.' },
        ],
        sutunlar: { kod: 'MasrafMerkezi', aciklama: 'Açıklama' },
        yokSayilanSutunlar: ['MasrafMerkeziNo', 'ŞirketNo', 'GlKod', 'BirinciOnaycı'],
      };
      expect(preview.body).toEqual({ onizleme: true, ...expected });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri')).body.toplam).toBe(0);
      expect(await listAudit(db, 5)).toEqual([]);

      const applied = await send(admin, '/api/masraf-merkezleri/ice-aktar', file);
      expect(applied.body).toEqual({ onizleme: false, ...expected });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri')).body.kayitlar.map((m: any) => [m.kod, m.aciklama])).toEqual([
        ['11033106', '11033106'],
        ['12043106', 'Satış'],
        ['13000001', null],
      ]);
      const log = await listAudit(db, 5);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        islem: 'tanim_ice_aktarildi',
        ayrinti: 'Masraf Merkezleri: 6 satır; 3 eklendi, 0 güncellendi, 0 değişmedi, 0 pasifleştirildi, 3 hatalı satır atlandı.',
      });
      // The same file again: nothing new.
      expect((await send(admin, '/api/masraf-merkezleri/ice-aktar', file)).body).toMatchObject({ eklenen: 0, degismeyen: 3, hataSayisi: 3 });
    });

    it('deactivates the active records the file leaves out, when asked', async () => {
      await makeCostCenter(db, 'ESKI', 'Eski merkez');
      await makeCostCenter(db, 'PASIF', null, false);
      await makeCostCenter(db, '13000001');
      const file = masraffCostCenters();
      expect((await send(admin, '/api/masraf-merkezleri/ice-aktar?onizleme=1&eksikleriPasiflestir=1', file)).body).toMatchObject({ onizleme: true, eklenen: 2, degismeyen: 1, pasiflestirilen: 1 });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?aktif=0')).body.toplam).toBe(1);
      expect((await send(admin, '/api/masraf-merkezleri/ice-aktar?eksikleriPasiflestir=1', file)).body).toMatchObject({ onizleme: false, pasiflestirilen: 1 });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri?aktif=0')).body.kayitlar.map((m: any) => m.kod)).toEqual(['ESKI', 'PASIF']);
    });

    it('reads the masraff tag and project lists into the option lists', async () => {
      const tags = workbook(
        ['Etiket No', 'Şirket No', 'Şirket Adı', 'EtiketAdı', 'EtiketAçıklaması', 'BirinciOnaycı'],
        ['1', '1000', 'Şirket', 'P34MHG325', 'P34MHG325-18036470', ''],
        ['2', '1000', 'Şirket', '06ABC123', '06ABC123', ''],
      );
      const res = await send(admin, '/api/alanlar/etiket/secenekler/ice-aktar', tags, 'multipart');
      expect(res.body).toMatchObject({ eklenen: 2, sutunlar: { kod: 'EtiketAdı', ad: 'EtiketAçıklaması' } });
      expect((await call(employee, 'GET', '/api/alanlar/etiket/secenekler')).body.kayitlar.map((s: any) => [s.gosterim, s.sira])).toEqual([
        ['P34MHG325 – P34MHG325-18036470', 1],
        ['06ABC123', 2],
      ]);

      const projects = workbook(['No', 'Proje Kodu', 'Proje  Açıklaması'], ['1', 'PRJ-001', 'Yeni kesimhane'], ['2', 'PRJ-002', '']);
      const p2 = await send(admin, '/api/alanlar/projeKodu/secenekler/ice-aktar', projects, 'octet');
      expect(p2.body).toMatchObject({ eklenen: 2, sutunlar: { kod: 'Proje Kodu', ad: 'Proje  Açıklaması' }, yokSayilanSutunlar: ['No'] });
      expect((await call(admin, 'GET', '/api/alanlar/projeKodu/secenekler')).body.kayitlar.map((s: any) => s.gosterim)).toEqual(['PRJ-001 – Yeni kesimhane', 'PRJ-002']);
    });

    it('matches categories by name and adds the new ones after the others', async () => {
      const file = workbook(
        ['Kategori No', 'Şirket Adı', 'Kategori Adı', 'Kategori Kodu', 'Kdv Oranları', 'Gl Kod 1', 'Gl Kod 2'],
        ['1', 'Şirket', 'YEMEK', 'YMK', '10', '7700000001', ''],
        ['2', 'Şirket', 'ARAÇ BAKIM ONARIM', '', '0, 1, 10, 20', '7609901001', ''],
      );
      expect((await send(admin, '/api/kategoriler/ice-aktar', file)).body).toMatchObject({ eklenen: 1, guncellenen: 1, hataSayisi: 0 });
      const all = (await call(admin, 'GET', '/api/kategoriler?tumu=1')).body as any[];
      expect(all.find((k) => k.id === 1)).toEqual({ id: 1, ad: 'YEMEK', simge: 'yemek', aktif: true, sira: 1, kod: 'YMK', kdvOranlari: '10', hesapKodu: '7700000001' });
      expect(all.at(-1)).toMatchObject({ ad: 'ARAÇ BAKIM ONARIM', simge: 'diger', sira: 10, kod: null, kdvOranlari: '0, 1, 10, 20', hesapKodu: '7609901001' });
    });

    it('imports and updates thousands of rows in batches', async () => {
      const rows = Array.from({ length: 2600 }, (_, i) => [`E${String(i).padStart(5, '0')}`, `Etiket ${i}`]);
      expect((await send(admin, '/api/alanlar/etiket/secenekler/ice-aktar', workbook(['Kod', 'Açıklama'], ...rows))).body).toMatchObject({ eklenen: 2600, hataSayisi: 0 });
      const changed = rows.map(([kod], i) => [kod ?? '', i % 2 === 0 ? `Değişti ${i}` : `Etiket ${i}`]);
      expect((await send(admin, '/api/alanlar/etiket/secenekler/ice-aktar', workbook(['Kod', 'Açıklama'], ...changed))).body).toMatchObject({ guncellenen: 1300, degismeyen: 1300 });
      const last = await call(admin, 'GET', '/api/alanlar/etiket/secenekler?adet=1&sayfa=2600');
      expect(last.body).toMatchObject({ toplam: 2600, kayitlar: [{ kod: 'E02599', ad: 'Etiket 2599', sira: 2600 }] });
      const counts = await queryOne<{ n: number; d: number }>(
        db,
        `SELECT COUNT(*) AS n, SUM(CASE WHEN s.ad LIKE N'Değişti%' THEN 1 ELSE 0 END) AS d FROM dbo.alan_secenekleri s JOIN dbo.alan_tanimlari a ON a.id = s.alan_id WHERE a.anahtar = 'etiket'`,
      );
      expect(counts).toEqual({ n: 2600, d: 1300 });
    });

    it('refuses what is not an .xlsx file, a file without its key column and an empty body', async () => {
      const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)]);
      const xls = await send(admin, '/api/organizasyonlar/ice-aktar', ole, 'octet');
      expectError(xls, 400, 'gecersiz_dosya');
      expect(xls.body.hata.mesaj).toBe('Yalnızca .xlsx (Excel 2007 ve sonrası) dosyaları içe aktarılabilir.');
      expectError(await send(admin, '/api/organizasyonlar/ice-aktar', Buffer.from('Kod;Ad\n1000;Şirket\n', 'utf8'), 'octet'), 400, 'gecersiz_dosya');
      const noKey = await send(admin, '/api/masraf-merkezleri/ice-aktar', workbook(['Açıklama'], ['x']));
      expectError(noKey, 400, 'gecersiz_dosya');
      expect(noKey.body.hata.mesaj).toBe('Dosyada kod sütunu bulunamadı. Beklenen başlıklardan biri: Kod, Masraf Merkezi, Masraf Merkezi Kodu.');
      expectError(await send(admin, '/api/organizasyonlar/ice-aktar', Buffer.alloc(0)), 400, 'gecersiz_dosya');
      expectError(await send(admin, '/api/organizasyonlar/ice-aktar', workbook(['Kod'], ['1']), 'multipart', 'file'), 400, 'gecersiz_dosya');
      expectError(await send(admin, '/api/alanlar/vergiDairesi/secenekler/ice-aktar', workbook(['Kod'], ['1'])), 404, 'bulunamadi');
      fieldError(await send(admin, '/api/organizasyonlar/ice-aktar?onizleme=evet', workbook(['Kod'], ['1'])), 'onizleme');
      expect((await call(admin, 'GET', '/api/organizasyonlar')).body.toplam).toBe(0);
    });

    it('refuses a file over 5 MB with 413, raw or in a form', async () => {
      const big = Buffer.alloc(5 * MB + 1, 0x20);
      expectError(await send(admin, '/api/organizasyonlar/ice-aktar', big, 'octet'), 413, 'dosya_cok_buyuk');
      expectError(await send(admin, '/api/organizasyonlar/ice-aktar', big, 'multipart'), 413, 'dosya_cok_buyuk');
      expectError(await send(admin, '/api/organizasyonlar/ice-aktar', Buffer.alloc(7 * MB, 0x20), 'octet'), 413, 'dosya_cok_buyuk');
    });
  });

  describe('users', () => {
    it('assigns an organisation and cost centres and returns them everywhere the user is', async () => {
      const org = await makeOrganization(db, '1000', 'Şenpiliç Gıda Sanayi A.Ş.');
      const b = await makeCostCenter(db, '12043106', 'Satış');
      const a = await makeCostCenter(db, '11033106', '11033106');
      const created = await call(admin, 'POST', '/api/kullanicilar', {
        eposta: 'yeni@firma.test',
        adSoyad: 'Yeni Kişi',
        rol: 'calisan',
        sifre: 'GizliSifre1',
        organizasyonId: org,
        masrafMerkeziIdler: [b, a],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.organizasyon).toEqual({ id: org, kod: '1000', ad: 'Şenpiliç Gıda Sanayi A.Ş.', aktif: true });
      expect(created.body.masrafMerkezleri).toEqual([
        { id: a, kod: '11033106', aciklama: '11033106', gosterim: '11033106', aktif: true },
        { id: b, kod: '12043106', aciklama: 'Satış', gosterim: '12043106 – Satış', aktif: true },
      ]);
      expect((await listAudit(db, 1))[0]?.ayrinti).toContain('organizasyon: 1000, masraf merkezleri: 11033106, 12043106');

      const plain = await call(admin, 'POST', '/api/kullanicilar', { eposta: 'sade@firma.test', adSoyad: 'Sade', rol: 'calisan', sifre: 'GizliSifre1' });
      expect(plain.body).toMatchObject({ organizasyon: null, masrafMerkezleri: [] });

      const list = (await call(admin, 'GET', '/api/kullanicilar')).body as any[];
      expect(list.find((u) => u.id === created.body.id)).toMatchObject({ organizasyon: { kod: '1000' }, masrafMerkezleri: [{ kod: '11033106' }, { kod: '12043106' }] });
      expect(list.find((u) => u.id === employee.id)).toMatchObject({ organizasyon: null, masrafMerkezleri: [] });

      await execute(db, 'UPDATE dbo.kullanicilar SET sifre_degismeli = 0 WHERE id = @id', { id: p.int(created.body.id) });
      const login = await call(null, 'POST', '/api/oturum', { eposta: 'yeni@firma.test', sifre: 'GizliSifre1', istemci: 'mobil' });
      expect(login.body.kullanici).toMatchObject({ organizasyon: { id: org }, masrafMerkezleri: [{ id: a }, { id: b }] });
      const me = await fetch(`${base}/api/ben`, { headers: { Authorization: `Bearer ${login.body.token}` } });
      expect(((await me.json()) as any).kullanici).toMatchObject({ organizasyon: { kod: '1000' }, masrafMerkezleri: [{ kod: '11033106' }, { kod: '12043106' }] });
    });

    it('changes, keeps and clears them on PATCH and writes the change to the audit log', async () => {
      const org1 = await makeOrganization(db, '1000');
      const org2 = await makeOrganization(db, '2000');
      const [a, b, c] = [await makeCostCenter(db, 'A'), await makeCostCenter(db, 'B'), await makeCostCenter(db, 'C')];
      await assignDefinitions(db, employee.id, org1, [a, b]);
      const path = `/api/kullanicilar/${employee.id}`;

      expect((await call(admin, 'PATCH', path, { adSoyad: 'Çalışan Kişi' })).body).toMatchObject({ organizasyon: { id: org1 }, masrafMerkezleri: [{ id: a }, { id: b }] });
      const changed = await call(admin, 'PATCH', path, { organizasyonId: org2, masrafMerkeziIdler: [b, c] });
      expect(changed.body).toMatchObject({ organizasyon: { id: org2, kod: '2000' }, masrafMerkezleri: [{ kod: 'B' }, { kod: 'C' }] });
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'kullanici_guncellendi', ayrinti: 'Çalışan Kişi: organizasyon 1000 → 2000, masraf merkezleri +C -A' });

      const cleared = await call(admin, 'PATCH', path, { organizasyonId: null, masrafMerkeziIdler: [] });
      expect(cleared.body).toMatchObject({ organizasyon: null, masrafMerkezleri: [] });
      expect((await call(admin, 'GET', '/api/masraf-merkezleri')).body.kayitlar.map((m: any) => m.kullaniciSayisi)).toEqual([0, 0, 0]);
    });

    it('refuses missing and newly assigned inactive records, but keeps inactive ones already assigned', async () => {
      const org = await makeOrganization(db, '1000');
      const passiveOrg = await makeOrganization(db, '9000', 'Kapalı', false);
      const active = await makeCostCenter(db, 'AKTIF');
      const passive = await makeCostCenter(db, 'PASIF', null, false);
      const path = `/api/kullanicilar/${employee.id}`;

      fieldError(await call(admin, 'PATCH', path, { organizasyonId: 999_999 }), 'organizasyonId');
      fieldError(await call(admin, 'PATCH', path, { organizasyonId: passiveOrg }), 'organizasyonId');
      fieldError(await call(admin, 'PATCH', path, { masrafMerkeziIdler: [active, 999_999] }), 'masrafMerkeziIdler.1');
      fieldError(await call(admin, 'PATCH', path, { masrafMerkeziIdler: [passive] }), 'masrafMerkeziIdler.0');
      fieldError(await call(admin, 'PATCH', path, { masrafMerkeziIdler: [active, active] }), 'masrafMerkeziIdler.1');
      fieldError(await call(admin, 'PATCH', path, { masrafMerkeziIdler: Array.from({ length: 101 }, (_, i) => i + 1) }), 'masrafMerkeziIdler');
      fieldError(await call(admin, 'PATCH', path, { masrafMerkeziIdler: 'AKTIF' }), 'masrafMerkeziIdler');
      fieldError(
        await call(admin, 'POST', '/api/kullanicilar', { eposta: 'x@firma.test', adSoyad: 'X', rol: 'calisan', sifre: 'GizliSifre1', masrafMerkeziIdler: [passive] }),
        'masrafMerkeziIdler.0',
      );
      expect((await call(admin, 'GET', path)).body).toMatchObject({ organizasyon: null, masrafMerkezleri: [] });

      // Assigned while active, then deactivated: the assignment may stay.
      await assignDefinitions(db, employee.id, org, [active]);
      await execute(db, 'UPDATE dbo.organizasyonlar SET aktif = 0 WHERE id = @id; UPDATE dbo.masraf_merkezleri SET aktif = 0 WHERE id = @m', { id: p.int(org), m: p.int(active) });
      const kept = await call(admin, 'PATCH', path, { organizasyonId: org, masrafMerkeziIdler: [active] });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(kept.body).toMatchObject({ organizasyon: { id: org, aktif: false }, masrafMerkezleri: [{ id: active, aktif: false }] });
    });
  });
});
