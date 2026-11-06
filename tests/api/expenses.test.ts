// Administration, expense forms, approvals, export and invoice access over HTTP (docs/onay-sistemi.md,
// section 6). The rules themselves are tested on the service in tests/expenses/forms.test.ts; this file
// checks what clients see: status codes, error codes, shapes, roles and races through the API.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp } from '../../src/api/app.ts';
import type { ExtractInvoice } from '../../src/claude/extractor.ts';
import { type Db } from '../../src/db/sql.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { PDF_BYTES, PNG_BYTES, sampleExtraction, sampleInvoice, sampleOlcum } from '../helpers.ts';
import { assignFlow, chainOf, closeTestDb, defaultFlowId, makeFlow, makeInvoice, makeUser, resetDb, setFlow, testDb, tokenFor } from '../db.ts';

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
}

const PAST = '2025-06-15';
const formBody = (over: Record<string, unknown> = {}) => ({ baslik: 'Müşteri yemeği', kategoriId: 1, masrafTarihi: PAST, tutar: 100, ...over });

const SUMMARY_KEYS = ['id', 'baslik', 'kategori', 'masrafTarihi', 'satici', 'tutar', 'paraBirimi', 'yerelTutar', 'durum', 'olusturan', 'olusturma', 'gonderim', 'siradakiOnayci', 'faturaIdler'];
const DETAIL_KEYS = [...SUMMARY_KEYS, 'aciklama', 'kur', 'onayTutari', 'tur', 'sonuclanma', 'odeme', 'guncelleme', 'faturalar', 'tutarFarki', 'onaylar', 'gecmis', 'izinler'];
const NONE = { duzenle: false, gonder: false, geriCek: false, iptal: false, onayla: false, reddet: false, odendi: false, devret: false };

describe('expense, approval and administration API', () => {
  let db: Db;
  let server: Server;
  let base: string;
  let extract: Mock<ExtractInvoice>;
  let files = 0;

  // The cast of every test: a, b and c may be put in the flow; owner sends forms; outsider sees nothing.
  let admin: Kullanici;
  let accounting: Kullanici;
  let a: Kullanici;
  let b: Kullanici;
  let owner: Kullanici;
  let outsider: Kullanici;
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
    a = await makeUser(db, { adSoyad: 'Onaycı A' });
    b = await makeUser(db, { adSoyad: 'Onaycı B' });
    owner = await makeUser(db, { adSoyad: 'Form Sahibi' });
    outsider = await makeUser(db, { adSoyad: 'Başkası' });
    tokens.clear();
    for (const u of [admin, accounting, a, b, owner, outsider]) tokens.set(u.id, await tokenFor(db, u.id));
    await setFlow(db, chainOf(admin.id));

    extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    server.on('request', createApp({ extract, db, maxFileBytes: 1024 * 1024, port, log: () => {} }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = async (who: Kullanici, method: string, path: string, body?: unknown): Promise<Answer> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokenOf(who)}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // CSV and other non-JSON answers stay text
    }
    return { status: res.status, headers: res.headers, body: parsed };
  };

  const expectError = (res: Answer, status: number, kod: string): void => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body).toMatchObject({ hata: { kod, mesaj: expect.any(String) } });
  };

  const fieldError = (res: Answer, alan: string): void => {
    expectError(res, 400, 'gecersiz_istek');
    // Array items are named by path ("durum.0").
    const keys = Object.keys(res.body.hata.alanlar ?? {}).map((k) => (k.startsWith(`${alan}.`) && /^\d+$/.test(k.slice(alan.length + 1)) ? alan : k));
    expect(keys, JSON.stringify(res.body)).toContain(alan);
  };

  /** Creates a form as `who`; sent at once unless gonder is false. */
  const create = async (who: Kullanici, over: Record<string, unknown> = {}, gonder = true): Promise<any> => {
    const res = await call(who, 'POST', '/api/masraflar', { ...formBody(over), gonder });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };

  const act = (who: Kullanici, formId: number, action: string, body?: unknown): Promise<Answer> =>
    call(who, 'POST', `/api/masraflar/${formId}/${action}`, body ?? {});

  /** Uploads a distinct file (the service never reads the same bytes twice) and returns the invoice id. */
  const upload = async (who: Kullanici, kind: 'pdf' | 'png' = 'pdf', fatura: Parameters<typeof sampleInvoice>[0] = {}): Promise<{ id: string; bytes: Buffer }> => {
    extract.mockResolvedValueOnce({ sonuc: sampleInvoice(fatura), olcum: sampleOlcum() });
    files++;
    const bytes = Buffer.concat([kind === 'pdf' ? PDF_BYTES : PNG_BYTES, Buffer.from(`\n% dosya ${files} ${Date.now()}\n`)]);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), kind === 'pdf' ? 'Fiş Ekim.pdf' : 'fis.png');
    const res = await fetch(`${base}/api/invoices`, { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(who)}` }, body: form });
    expect(res.status).toBe(201);
    return { id: res.headers.get('x-fatura-id') ?? '', bytes };
  };

  describe('administration', () => {
    it('is for administrators only', async () => {
      const someone = `/api/kullanicilar/${a.id}`;
      const genel = await defaultFlowId(db);
      const requests: Array<[string, string, unknown?]> = [
        ['GET', '/api/kullanicilar'],
        ['POST', '/api/kullanicilar', { eposta: 'x@firma.test', adSoyad: 'X', rol: 'calisan', sifre: 'GizliSifre1' }],
        ['GET', someone],
        ['PATCH', someone, { adSoyad: 'Değişti' }],
        ['POST', `${someone}/sifre`, { yeniSifre: 'YeniSifre2026' }],
        ['GET', '/api/denetim'],
        ['GET', '/api/onay-akislari'],
        ['POST', '/api/onay-akislari', { ad: 'Satış', strateji: 'zincir', adimlar: chainOf(a.id) }],
        ['GET', `/api/onay-akislari/${genel}`],
        ['PUT', `/api/onay-akislari/${genel}`, { ad: 'Genel', strateji: 'zincir', adimlar: chainOf(a.id) }],
        ['POST', `/api/onay-akislari/${genel}/varsayilan`],
        ['DELETE', `/api/onay-akislari/${genel}`],
        ['POST', '/api/kategoriler', { ad: 'Yeni' }],
        ['PATCH', '/api/kategoriler/1', { aktif: false }],
      ];
      for (const who of [accounting, a]) {
        for (const [method, path, body] of requests) expectError(await call(who, method, path, body), 403, 'yetki_yok');
      }
      expect((await call(admin, 'GET', someone)).body.adSoyad).toBe('Onaycı A');
      expect((await call(admin, 'GET', `/api/onay-akislari/${genel}`)).body.adimlar).toHaveLength(1);
      // The single-flow endpoints are gone.
      expectError(await call(admin, 'GET', '/api/onay-akisi'), 404, 'bulunamadi');
    });

    it('creates users with 201 and Location, refusing taken e-mails and bad fields', async () => {
      const res = await call(admin, 'POST', '/api/kullanicilar', { eposta: 'Yeni.Kisi@Firma.test', adSoyad: 'Yeni Kişi', rol: 'muhasebe', departman: 'Finans', sifre: 'GizliSifre1' });
      expect(res.status).toBe(201);
      expect(res.headers.get('location')).toBe(`/api/kullanicilar/${res.body.id}`);
      expect(res.body).toMatchObject({ eposta: 'yeni.kisi@firma.test', adSoyad: 'Yeni Kişi', rol: 'muhasebe', departman: 'Finans', aktif: true, sifreDegismeli: true, onayAkisiId: null, onayAkisi: { ad: 'Genel', varsayilan: true }, onaycilik: [] });
      expect(res.body).not.toHaveProperty('sifreOzeti');

      expectError(await call(admin, 'POST', '/api/kullanicilar', { eposta: 'YENI.kisi@firma.test', adSoyad: 'Kopya', rol: 'calisan', sifre: 'GizliSifre1' }), 409, 'eposta_kullaniliyor');
      fieldError(await call(admin, 'POST', '/api/kullanicilar', { eposta: 'z@firma.test', adSoyad: 'Z', rol: 'patron', sifre: 'GizliSifre1' }), 'rol');
      fieldError(await call(admin, 'POST', '/api/kullanicilar', { eposta: 'eposta-degil', adSoyad: 'Z', rol: 'calisan', sifre: 'GizliSifre1' }), 'eposta');
      fieldError(await call(admin, 'POST', '/api/kullanicilar', { eposta: 'z@firma.test', adSoyad: 'Z', rol: 'calisan', sifre: 'kisa' }), 'sifre');
      expectError(await call(admin, 'GET', '/api/kullanicilar/999999'), 404, 'bulunamadi');
      expectError(await call(admin, 'GET', '/api/kullanicilar/abc'), 404, 'bulunamadi');

      const list = await call(admin, 'GET', '/api/kullanicilar?q=yeni');
      expect(list.body.map((u: Kullanici) => u.id)).toEqual([res.body.id]);
      expect((await call(admin, 'GET', '/api/denetim?adet=1')).body).toEqual([
        { id: expect.any(Number), islem: 'kullanici_olusturuldu', ayrinti: expect.stringContaining('yeni.kisi@firma.test'), kullanici: { id: admin.id, adSoyad: 'Yönetici' }, tarih: expect.any(String) },
      ]);
    });

    it('guards changes: last administrator, own account, flow members and undecided approvals', async () => {
      expectError(await call(admin, 'PATCH', `/api/kullanicilar/${admin.id}`, { rol: 'calisan' }), 409, 'son_yonetici');
      expectError(await call(admin, 'PATCH', `/api/kullanicilar/${admin.id}`, { aktif: false }), 409, 'kendi_hesabi');

      await setFlow(db, chainOf(a.id, b.id));
      expectError(await call(admin, 'PATCH', `/api/kullanicilar/${a.id}`, { aktif: false }), 409, 'onay_akisinda');
      await create(owner);
      await setFlow(db, chainOf(admin.id));
      expectError(await call(admin, 'PATCH', `/api/kullanicilar/${b.id}`, { aktif: false }), 409, 'bekleyen_onay_var');
      expectError(await call(admin, 'PATCH', `/api/kullanicilar/${owner.id}`, { eposta: a.eposta.toUpperCase() }), 409, 'eposta_kullaniliyor');

      fieldError(await call(admin, 'PATCH', `/api/kullanicilar/${owner.id}`, { sifre: 'GizliSifre1' }), '_');
      fieldError(await call(admin, 'PATCH', `/api/kullanicilar/${owner.id}`, { aktif: 'hayir' }), 'aktif');
      expectError(await call(admin, 'PATCH', '/api/kullanicilar/999999', { adSoyad: 'Kimse' }), 404, 'bulunamadi');

      const ok = await call(admin, 'PATCH', `/api/kullanicilar/${outsider.id}`, { aktif: false });
      expect(ok.status).toBe(200);
      expect(ok.body.aktif).toBe(false);
      // A deactivated user is signed out at once.
      expectError(await call(outsider, 'GET', '/api/ben'), 401, 'oturum_gerekli');
      expect((await call(admin, 'GET', '/api/kullanicilar?aktif=false')).body.map((u: Kullanici) => u.id)).toEqual([outsider.id]);
      expect((await call(admin, 'GET', '/api/denetim?adet=1')).body[0]).toMatchObject({ islem: 'kullanici_guncellendi', ayrinti: expect.stringContaining('pasifleştirildi') });
    });

    it('saves an approval flow or lists every problem in sorunlar', async () => {
      const url = `/api/onay-akislari/${await defaultFlowId(db)}`;
      const empty = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'zincir', adimlar: [] });
      expectError(empty, 400, 'gecersiz_akis');
      expect(empty.body.hata.sorunlar).toEqual(['Onay akışında en az bir onaycı olmalıdır.']);

      // Limits rise along the flow and only the last approver has none.
      const falling = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'tek', adimlar: [{ onayciId: a.id, limit: 5000 }, { onayciId: b.id, limit: 1000 }] });
      expectError(falling, 400, 'gecersiz_akis');
      expect(falling.body.hata.sorunlar).toEqual([
        'Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.',
        '2. onaycının limiti, 1. onaycınınkinden (5.000,00 TRY) büyük olmalıdır.',
      ]);
      expect(falling.body.hata.mesaj).toBe(falling.body.hata.sorunlar[0]);
      const open = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'zincir', adimlar: [{ onayciId: a.id, limit: null }, { onayciId: b.id, limit: null }] });
      expectError(open, 400, 'gecersiz_akis');
      expect(open.body.hata.sorunlar).toEqual(['1. onaycı: onay limiti girilmelidir. Yalnızca son onaycının limiti sınırsızdır.']);
      const zero = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'zincir', adimlar: [{ onayciId: a.id, limit: 0 }, { onayciId: b.id, limit: null }] });
      expectError(zero, 400, 'gecersiz_akis');
      expect(zero.body.hata.sorunlar).toEqual(["1. onaycı: onay limiti 0'dan büyük ve en fazla 90.000.000.000.000,00 TRY olmalıdır."]);

      const passive = await makeUser(db, { adSoyad: 'Pasif Onaycı', aktif: false });
      const users = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'zincir', adimlar: chainOf(a.id, passive.id, 999_999) });
      expectError(users, 400, 'gecersiz_akis');
      expect(users.body.hata.sorunlar).toEqual(['2. onaycı: Pasif Onaycı pasif bir kullanıcı.', '3. onaycı: kullanıcı bulunamadı.']);

      const limitError = async (adimlar: unknown, mesaj: string): Promise<void> => {
        const res = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'zincir', adimlar });
        fieldError(res, 'adimlar.0.limit');
        expect(res.body.hata.alanlar['adimlar.0.limit']).toBe(mesaj);
      };
      await limitError([{ onayciId: a.id, limit: -1 }, { onayciId: b.id, limit: null }], 'Onay limiti sıfırdan küçük olamaz.');
      await limitError([{ onayciId: a.id, limit: 0.001 }, { onayciId: b.id, limit: null }], 'Onay limiti en fazla iki ondalık basamak içerebilir.');
      await limitError([{ onayciId: a.id, limit: '5000' }, { onayciId: b.id, limit: null }], 'Onay limiti sayı olmalıdır.');
      // "No limit" is said with null, not by leaving the field out.
      await limitError([{ onayciId: a.id }], 'Onay limiti sayı olmalıdır.');
      for (const strateji of [undefined, 'hepsi', 'ZINCIR', null]) {
        const res = await call(admin, 'PUT', url, { ad: 'Genel', strateji, adimlar: chainOf(a.id) });
        fieldError(res, 'strateji');
        expect(res.body.hata.alanlar.strateji, String(strateji)).toBe('Strateji "zincir" ya da "tek" olmalıdır.');
      }
      fieldError(await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'zincir' }), 'adimlar');
      fieldError(await call(admin, 'PUT', url, { strateji: 'zincir', adimlar: chainOf(a.id) }), 'ad');
      fieldError(await call(admin, 'PUT', url, { ad: 'x'.repeat(81), strateji: 'zincir', adimlar: chainOf(a.id) }), 'ad');
      expectError(await call(admin, 'PUT', '/api/onay-akislari/999999', { ad: 'Yok', strateji: 'zincir', adimlar: chainOf(a.id) }), 404, 'bulunamadi');
      expect((await call(admin, 'GET', url)).body).toMatchObject({ strateji: 'zincir', adimlar: [{ onayci: { id: admin.id }, limit: null }] });

      const saved = await call(admin, 'PUT', url, { ad: 'Genel', strateji: 'tek', adimlar: [{ onayciId: a.id, limit: 5000 }, { onayciId: b.id, limit: null }] });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        id: await defaultFlowId(db),
        ad: 'Genel',
        varsayilan: true,
        strateji: 'tek',
        paraBirimi: 'TRY',
        guncelleme: expect.any(String),
        guncelleyen: { id: admin.id, adSoyad: 'Yönetici' },
        kullaniciSayisi: 6,
        adimlar: [
          { sira: 1, onayci: { id: a.id, adSoyad: 'Onaycı A', eposta: a.eposta, departman: null }, limit: 5000 },
          { sira: 2, onayci: { id: b.id, adSoyad: 'Onaycı B', eposta: b.eposta, departman: null }, limit: null },
        ],
      });
      expect((await call(admin, 'GET', url)).body).toEqual(saved.body);
      expect((await call(admin, 'GET', '/api/denetim?adet=1')).body[0]).toMatchObject({
        islem: 'onay_akisi_guncellendi',
        kullanici: { id: admin.id },
        ayrinti: "Genel: tek onaycı; 1) Onaycı A: 5.000,00 TRY'ye kadar; 2) Onaycı B: sınırsız",
      });
      // Each approver's place: their limit and the amounts that come to them.
      const genel = { id: saved.body.id, ad: 'Genel', strateji: 'tek' };
      expect((await call(admin, 'GET', `/api/kullanicilar/${a.id}`)).body.onaycilik).toEqual([{ akis: genel, sira: 1, limit: 5000, altLimit: 0, ustLimit: 5000 }]);
      expect((await call(admin, 'GET', `/api/kullanicilar/${b.id}`)).body.onaycilik).toEqual([{ akis: genel, sira: 2, limit: null, altLimit: 5000.01, ustLimit: null }]);
      expect((await call(a, 'GET', '/api/ben')).body.kullanici.onaycilik).toEqual([{ akis: genel, sira: 1, limit: 5000, altLimit: 0, ustLimit: 5000 }]);
    });

    it('creates, lists, defaults and deletes flows, and assigns users to them', async () => {
      const genel = await defaultFlowId(db);
      const created = await call(admin, 'POST', '/api/onay-akislari', { ad: 'Satış', strateji: 'zincir', adimlar: chainOf(a.id) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.headers.get('location')).toBe(`/api/onay-akislari/${created.body.id}`);
      expect(created.body).toMatchObject({ ad: 'Satış', varsayilan: false, strateji: 'zincir', kullaniciSayisi: 0, adimlar: [{ sira: 1, onayci: { id: a.id }, limit: null }] });
      const satis: number = created.body.id;
      expectError(await call(admin, 'POST', '/api/onay-akislari', { ad: 'satış', strateji: 'zincir', adimlar: chainOf(b.id) }), 409, 'akis_adi_kullaniliyor');
      expectError(await call(admin, 'POST', '/api/onay-akislari', { ad: 'Boş', strateji: 'zincir', adimlar: [] }), 400, 'gecersiz_akis');
      fieldError(await call(admin, 'POST', '/api/onay-akislari', { ad: 'Stratejisiz', adimlar: chainOf(b.id) }), 'strateji');
      const tek = await call(admin, 'POST', '/api/onay-akislari', { ad: 'Kademe', strateji: 'tek', adimlar: [{ onayciId: b.id, limit: 1000 }, { onayciId: a.id, limit: null }] });
      expect(tek.status, JSON.stringify(tek.body)).toBe(201);
      expect(tek.body).toMatchObject({ strateji: 'tek', adimlar: [{ onayci: { id: b.id }, limit: 1000 }, { onayci: { id: a.id }, limit: null }] });
      expect((await call(admin, 'DELETE', `/api/onay-akislari/${tek.body.id}`)).status).toBe(204);

      // Assigning: on create and on change; null goes back to the default.
      const user = await call(admin, 'POST', '/api/kullanicilar', { eposta: 'satisci@firma.test', adSoyad: 'Satışçı', rol: 'calisan', sifre: 'GizliSifre1', onayAkisiId: satis });
      expect(user.body).toMatchObject({ onayAkisiId: satis, onayAkisi: { id: satis, ad: 'Satış', varsayilan: false } });
      const moved = await call(admin, 'PATCH', `/api/kullanicilar/${owner.id}`, { onayAkisiId: satis });
      expect(moved.body).toMatchObject({ onayAkisiId: satis, onayAkisi: { id: satis } });
      fieldError(await call(admin, 'PATCH', `/api/kullanicilar/${owner.id}`, { onayAkisiId: 999_999 }), 'onayAkisiId');
      fieldError(await call(admin, 'PATCH', `/api/kullanicilar/${owner.id}`, { onayAkisiId: 'satis' }), 'onayAkisiId');
      expect((await call(admin, 'GET', `/api/kullanicilar/${a.id}`)).body.onaycilik).toEqual([
        { akis: { id: satis, ad: 'Satış', strateji: 'zincir' }, sira: 1, limit: null, altLimit: 0, ustLimit: null },
      ]);

      const list = await call(admin, 'GET', '/api/onay-akislari');
      expect(list.body.map((f: { ad: string; kullaniciSayisi: number }) => [f.ad, f.kullaniciSayisi])).toEqual([
        ['Genel', 5],
        ['Satış', 2],
      ]);

      // The owner's forms now go to the Satış flow.
      expect((await create(owner)).onaylar.map((o: { onayci: { id: number } }) => o.onayci.id)).toEqual([a.id]);

      const def = await call(admin, 'POST', `/api/onay-akislari/${satis}/varsayilan`);
      expect(def.status).toBe(200);
      expect(def.body).toMatchObject({ id: satis, varsayilan: true });
      expectError(await call(admin, 'DELETE', `/api/onay-akislari/${satis}`), 409, 'varsayilan_akis');
      await call(admin, 'POST', `/api/onay-akislari/${genel}/varsayilan`);
      const gone = await call(admin, 'DELETE', `/api/onay-akislari/${satis}`);
      expect(gone.status).toBe(204);
      expect((await call(admin, 'GET', `/api/kullanicilar/${owner.id}`)).body).toMatchObject({ onayAkisiId: null, onayAkisi: { id: genel } });
      expectError(await call(admin, 'GET', `/api/onay-akislari/${satis}`), 404, 'bulunamadi');
      expectError(await call(admin, 'DELETE', '/api/onay-akislari/abc'), 404, 'bulunamadi');
    });
  });

  describe('forms', () => {
    it('answers 201 with Location and the detail the contract describes', async () => {
      await setFlow(db, chainOf(a.id));
      const res = await call(owner, 'POST', '/api/masraflar', { ...formBody({ satici: 'Örnek Lokanta', aciklama: 'Müşteri ziyareti' }), gonder: true });
      expect(res.status).toBe(201);
      expect(res.headers.get('location')).toBe(`/api/masraflar/${res.body.id}`);
      expect(Object.keys(res.body).sort()).toEqual([...DETAIL_KEYS].sort());
      expect(res.body).toMatchObject({
        durum: 'onayda',
        tur: 1,
        kategori: { id: 1, ad: 'Yemek', simge: 'yemek' },
        olusturan: { id: owner.id, adSoyad: 'Form Sahibi' },
        siradakiOnayci: { id: a.id, adSoyad: 'Onaycı A' },
        faturaIdler: [],
        faturalar: [],
        tutarFarki: null,
        izinler: { ...NONE, geriCek: true },
      });
      expect(Object.keys(res.body.onaylar[0]).sort()).toEqual(['aciklama', 'altLimit', 'id', 'kararTarihi', 'onayci', 'sira', 'tur', 'ustLimit', 'durum', 'yedek'].sort());
      expect(Object.keys(res.body.gecmis[0]).sort()).toEqual(['aciklama', 'islem', 'kullanici', 'tarih']);

      const detail = await call(owner, 'GET', `/api/masraflar/${res.body.id}`);
      expect(detail.body).toEqual(res.body);
      const list = await call(owner, 'GET', '/api/masraflar');
      expect(list.body).toMatchObject({ toplam: 1, sayfa: 1, adet: 20 });
      expect(Object.keys(list.body.kayitlar[0]).sort()).toEqual([...SUMMARY_KEYS].sort());
    });

    it('validates fields with 400 gecersiz_istek and a message per field', async () => {
      const post = (over: Record<string, unknown>) => call(owner, 'POST', '/api/masraflar', formBody(over));
      fieldError(await post({ tutar: 0 }), 'tutar');
      fieldError(await post({ tutar: -5 }), 'tutar');
      fieldError(await post({ tutar: 10.005 }), 'tutar');
      fieldError(await post({ tutar: '100' }), 'tutar');
      fieldError(await post({ masrafTarihi: '2099-01-01' }), 'masrafTarihi');
      fieldError(await post({ masrafTarihi: '2025-02-30' }), 'masrafTarihi');
      fieldError(await post({ masrafTarihi: '15.06.2025' }), 'masrafTarihi');
      fieldError(await post({ baslik: '   ' }), 'baslik');
      fieldError(await post({ baslik: 'x'.repeat(121) }), 'baslik');
      fieldError(await post({ kategoriId: 999 }), 'kategoriId');
      fieldError(await post({ paraBirimi: 'usd' }), 'kur');
      fieldError(await post({ paraBirimi: 'DOLAR', kur: 40 }), 'paraBirimi');
      fieldError(await post({ paraBirimi: 'USD', kur: 0 }), 'kur');
      fieldError(await post({ faturaIdler: ['abc'] }), 'faturaIdler');
      fieldError(await post({ faturaIdler: '20250101-000000-deadbeef' }), 'faturaIdler');
      fieldError(await post({ faturaIdler: ['20250101-000000-deadbeef', '20250101-000000-deadbeef'] }), 'faturaIdler');
      fieldError(await post({ faturaIdler: Array.from({ length: 21 }, (_, i) => `20250101-000000-${String(i).padStart(8, '0')}`) }), 'faturaIdler');
      // The single-invoice field of the old contract is refused, not silently dropped.
      fieldError(await post({ faturaId: '20250101-000000-deadbeef' }), '_');
      fieldError(await post({ durum: 'onaylandi' }), '_');
      expect((await call(owner, 'GET', '/api/masraflar')).body.toplam).toBe(0);

      const usd = await call(owner, 'POST', '/api/masraflar', formBody({ paraBirimi: 'usd', kur: 32.5 }));
      expect(usd.status).toBe(201);
      expect(usd.body).toMatchObject({ paraBirimi: 'USD', kur: 32.5, yerelTutar: 3250, durum: 'taslak' });

      fieldError(await call(owner, 'PATCH', `/api/masraflar/${usd.body.id}`, { tutar: 0 }), 'tutar');
      fieldError(await call(owner, 'PATCH', `/api/masraflar/${usd.body.id}`, { gonder: true }), '_');
      expectError(await call(owner, 'GET', '/api/masraflar/abc'), 404, 'bulunamadi');
      expectError(await call(owner, 'POST', '/api/masraflar/abc/onayla'), 404, 'bulunamadi');
    });

    it('requires a reason of at least 3 characters to reject', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await create(owner);
      fieldError(await act(a, f.id, 'reddet', {}), 'aciklama');
      fieldError(await act(a, f.id, 'reddet', { aciklama: '  ab ' }), 'aciklama');
      const rejected = await act(a, f.id, 'reddet', { aciklama: 'Fiş eksik' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.durum).toBe('reddedildi');
    });

    it('answers each refusal with its status and code', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await create(owner);
      const draft = await create(owner, {}, false);

      expectError(await call(outsider, 'GET', `/api/masraflar/${f.id}`), 404, 'bulunamadi');
      expectError(await act(outsider, f.id, 'onayla'), 404, 'bulunamadi');
      expectError(await call(outsider, 'PATCH', `/api/masraflar/${draft.id}`, { tutar: 1 }), 404, 'bulunamadi');
      expectError(await call(owner, 'GET', '/api/masraflar/999999'), 404, 'bulunamadi');

      expectError(await act(b, f.id, 'onayla'), 409, 'onay_beklemiyor');
      expectError(await act(owner, f.id, 'onayla'), 409, 'onay_beklemiyor');
      expectError(await act(admin, f.id, 'reddet', { aciklama: 'Olmaz' }), 409, 'onay_beklemiyor');
      expectError(await act(a, draft.id, 'onayla'), 404, 'bulunamadi');

      expectError(await act(a, f.id, 'geri-cek'), 403, 'yetki_yok');
      expectError(await act(a, f.id, 'iptal'), 403, 'yetki_yok');
      expectError(await call(a, 'PATCH', `/api/masraflar/${f.id}`, { tutar: 1 }), 403, 'yetki_yok');
      expectError(await act(owner, f.id, 'odendi'), 403, 'yetki_yok');
      expectError(await act(accounting, f.id, 'devret', { onayId: f.onaylar[0].id, yeniOnayciId: outsider.id }), 403, 'yetki_yok');

      expectError(await call(owner, 'PATCH', `/api/masraflar/${f.id}`, { tutar: 1 }), 409, 'gecersiz_durum');
      expectError(await act(owner, f.id, 'gonder'), 409, 'gecersiz_durum');
      expectError(await act(owner, f.id, 'iptal'), 409, 'gecersiz_durum');
      expectError(await act(owner, draft.id, 'geri-cek'), 409, 'gecersiz_durum');
      expectError(await act(accounting, f.id, 'odendi'), 409, 'gecersiz_durum');
      expectError(await act(admin, draft.id, 'devret', { onayId: f.onaylar[0].id, yeniOnayciId: outsider.id }), 409, 'gecersiz_durum');

      expectError(await call(owner, 'GET', '/api/masraflar?kapsam=tumu'), 403, 'yetki_yok');
      fieldError(await call(owner, 'GET', '/api/masraflar?durum=bilinmiyor'), 'durum');
      fieldError(await call(owner, 'GET', '/api/onaylar?durum=hepsi'), 'durum');
    });

    it('hands a step over through the API and moves the pending count with it', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await create(owner);
      const step = f.onaylar[0].id;
      const passive = await makeUser(db, { aktif: false });
      fieldError(await act(admin, f.id, 'devret', { onayId: step, yeniOnayciId: passive.id }), 'yeniOnayciId');
      fieldError(await act(admin, f.id, 'devret', { onayId: step, yeniOnayciId: owner.id }), 'yeniOnayciId');
      fieldError(await act(admin, f.id, 'devret', { onayId: step }), 'yeniOnayciId');
      fieldError(await act(admin, f.id, 'devret', { onayId: 'x', yeniOnayciId: outsider.id }), 'onayId');

      const moved = await act(admin, f.id, 'devret', { onayId: step, yeniOnayciId: outsider.id });
      expect(moved.status).toBe(200);
      expect(moved.body.onaylar.map((o: { onayci: { id: number }; durum: string }) => [o.onayci.id, o.durum])).toEqual([
        [outsider.id, 'bekliyor'],
        [b.id, 'sirada'],
      ]);
      expect((await call(outsider, 'GET', '/api/ben')).body.bekleyenOnay).toBe(1);
      expect((await call(a, 'GET', '/api/ben')).body.bekleyenOnay).toBe(0);
      expect((await call(outsider, 'GET', '/api/onaylar')).body.map((x: { id: number }) => x.id)).toEqual([f.id]);
      expect((await act(outsider, f.id, 'onayla')).status).toBe(200);
    });
  });

  describe('races through the API', () => {
    beforeEach(async () => {
      await setFlow(db, chainOf(a.id, b.id));
    });

    it('accepts one of two simultaneous approvals', async () => {
      const f = await create(owner);
      const answers = await Promise.all([act(a, f.id, 'onayla'), act(a, f.id, 'onayla')]);
      expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(answers.find((r) => r.status === 409)?.body.hata.kod).toBe('onay_beklemiyor');
      const d = (await call(owner, 'GET', `/api/masraflar/${f.id}`)).body;
      expect(d.onaylar.map((o: { durum: string }) => o.durum)).toEqual(['onaylandi', 'bekliyor']);
      expect(d.gecmis.filter((g: { islem: string }) => g.islem === 'onaylandi')).toHaveLength(1);
    });

    it('sends a draft once when it is sent twice at the same time', async () => {
      const draft = await create(owner, {}, false);
      const answers = await Promise.all([act(owner, draft.id, 'gonder'), act(owner, draft.id, 'gonder')]);
      expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(answers.find((r) => r.status === 409)?.body.hata.kod).toBe('gecersiz_durum');
      const d = (await call(owner, 'GET', `/api/masraflar/${draft.id}`)).body;
      expect(d).toMatchObject({ tur: 1, durum: 'onayda' });
      expect(d.gecmis.filter((g: { islem: string }) => g.islem === 'gonderildi')).toHaveLength(1);
    });

    it('lets either a hand-over or the decision of the approver win, never both', async () => {
      const f = await create(owner);
      const answers = await Promise.all([act(a, f.id, 'onayla'), act(admin, f.id, 'devret', { onayId: f.onaylar[0].id, yeniOnayciId: outsider.id })]);
      expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
      const d = (await call(admin, 'GET', `/api/masraflar/${f.id}`)).body;
      expect(d.onaylar.filter((o: { durum: string }) => o.durum === 'bekliyor')).toHaveLength(1);
      if (answers[0]?.status === 200) {
        expectError(answers[1] as Answer, 400, 'gecersiz_istek');
        expect(d.onaylar.map((o: { onayci: { id: number }; durum: string }) => [o.onayci.id, o.durum])).toEqual([
          [a.id, 'onaylandi'],
          [b.id, 'bekliyor'],
        ]);
      } else {
        expectError(answers[0] as Answer, 404, 'bulunamadi');
        expect(d.onaylar.map((o: { onayci: { id: number }; durum: string }) => [o.onayci.id, o.durum])).toEqual([
          [outsider.id, 'bekliyor'],
          [b.id, 'sirada'],
        ]);
      }
    });
  });

  describe('visibility', () => {
    it('shows employees their own forms and the ones they approve; accounting and administrators see all', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await create(owner);
      const draft = await create(owner, { baslik: 'Taslak' }, false);
      const theirs = await create(outsider, { baslik: 'Başkasının' });

      const ids = (res: Answer): number[] => res.body.kayitlar.map((k: { id: number }) => k.id);
      expect(ids(await call(owner, 'GET', '/api/masraflar'))).toEqual([draft.id, f.id]);
      expect(ids(await call(owner, 'GET', '/api/masraflar?kapsam=benim&durum=taslak'))).toEqual([draft.id]);
      expect(ids(await call(a, 'GET', '/api/masraflar'))).toEqual([]);
      expect(ids(await call(accounting, 'GET', '/api/masraflar?kapsam=tumu'))).toEqual([theirs.id, draft.id, f.id]);
      expect(ids(await call(admin, 'GET', '/api/masraflar?kapsam=tumu&durum=onayda,taslak&adet=2'))).toEqual([theirs.id, draft.id]);
      expect((await call(admin, 'GET', '/api/masraflar?kapsam=tumu&adet=2')).body.toplam).toBe(3);

      const izinler = async (who: Kullanici, id: number) => {
        const res = await call(who, 'GET', `/api/masraflar/${id}`);
        expect(res.status, `${who.adSoyad} #${id}`).toBe(200);
        return res.body.izinler;
      };
      expect(await izinler(a, f.id)).toEqual({ ...NONE, onayla: true, reddet: true });
      expect(await izinler(b, f.id)).toEqual(NONE);
      expect(await izinler(owner, f.id)).toEqual({ ...NONE, geriCek: true });
      expect(await izinler(accounting, f.id)).toEqual(NONE);
      expect(await izinler(admin, f.id)).toEqual({ ...NONE, devret: true });
      expect(await izinler(owner, draft.id)).toEqual({ ...NONE, duzenle: true, gonder: true, iptal: true });
      expect(await izinler(accounting, draft.id)).toEqual(NONE);
      expectError(await call(a, 'GET', `/api/masraflar/${draft.id}`), 404, 'bulunamadi');
      expectError(await call(owner, 'GET', `/api/masraflar/${theirs.id}`), 404, 'bulunamadi');

      await act(a, f.id, 'onayla');
      await act(b, f.id, 'onayla');
      expect(await izinler(accounting, f.id)).toEqual({ ...NONE, odendi: true });
      expect(await izinler(admin, f.id)).toEqual({ ...NONE, odendi: true });
      expect(await izinler(owner, f.id)).toEqual(NONE);
      expect((await act(accounting, f.id, 'odendi')).body.durum).toBe('odendi');
      expect(await izinler(admin, f.id)).toEqual(NONE);
    });

    it('fills the approval inbox and the summary', async () => {
      await setFlow(db, chainOf(a.id));
      const first = await create(owner, { tutar: 100 });
      const second = await create(owner, { tutar: 250 });
      const inbox = await call(a, 'GET', '/api/onaylar');
      expect(inbox.body.map((x: { id: number }) => x.id)).toEqual([first.id, second.id]);
      expect(Object.keys(inbox.body[0]).sort()).toEqual([...SUMMARY_KEYS].sort());
      expect((await call(a, 'GET', '/api/onaylar?durum=karar')).body).toEqual([]);

      await act(a, first.id, 'onayla');
      expect((await call(a, 'GET', '/api/onaylar?durum=bekleyen')).body.map((x: { id: number }) => x.id)).toEqual([second.id]);
      expect((await call(a, 'GET', '/api/onaylar?durum=karar')).body.map((x: { id: number; durum: string }) => [x.id, x.durum])).toEqual([[first.id, 'onaylandi']]);

      const ozet = (await call(owner, 'GET', '/api/ozet')).body;
      expect(ozet).toMatchObject({ benim: { onayda: 1, onaylandi: 1, buAyToplam: 350, bekleyenTutar: 250 }, bekleyenOnay: 0, genel: null });
      expect(ozet.sonMasraflar.map((x: { id: number }) => x.id)).toEqual([second.id, first.id]);
      expect((await call(a, 'GET', '/api/ozet')).body.bekleyenOnay).toBe(1);
      expect((await call(accounting, 'GET', '/api/ozet')).body.genel).toEqual({ onayda: 1, odemeBekleyen: 1, odemeBekleyenTutar: 100, buAyOnaylanan: 100 });
    });

    it('previews the approvers for anyone, with only sirada and atlandi steps', async () => {
      await setFlow(db, [
        { onayciId: a.id, limit: 5000 },
        { onayciId: b.id, limit: null },
      ]);
      const preview = await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 20000 });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        onayTutari: 20000,
        paraBirimi: 'TRY',
        akis: { id: await defaultFlowId(db), ad: 'Genel', varsayilan: true },
        adimlar: [
          { sira: 1, onayci: { id: a.id, adSoyad: 'Onaycı A' }, durum: 'sirada', yedek: false },
          { sira: 2, onayci: { id: b.id, adSoyad: 'Onaycı B' }, durum: 'sirada', yedek: false },
        ],
        uyari: null,
      });
      // Their own expense goes one approver up, and above the top approver to an administrator.
      const own = await call(a, 'POST', '/api/onay-akisi/onizle', { tutar: 100 });
      expect(own.body.adimlar).toEqual([
        { sira: 1, onayci: { id: a.id, adSoyad: 'Onaycı A' }, durum: 'atlandi', yedek: false },
        { sira: 2, onayci: { id: b.id, adSoyad: 'Onaycı B' }, durum: 'sirada', yedek: false },
      ]);
      const top = await call(b, 'POST', '/api/onay-akisi/onizle', { tutar: 20000 });
      expect(top.body.adimlar).toEqual([
        { sira: 1, onayci: { id: a.id, adSoyad: 'Onaycı A' }, durum: 'sirada', yedek: false },
        { sira: 2, onayci: { id: b.id, adSoyad: 'Onaycı B' }, durum: 'atlandi', yedek: false },
        { sira: 3, onayci: { id: admin.id, adSoyad: 'Yönetici' }, durum: 'sirada', yedek: true },
      ]);

      const invoice = await upload(owner, 'pdf', { genelToplam: 6000 });
      const withInvoice = await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 4000, faturaIdler: [invoice.id] });
      expect(withInvoice.body.onayTutari).toBe(6000);
      expect(withInvoice.body.adimlar.map((s: { onayci: { id: number } }) => s.onayci.id)).toEqual([a.id, b.id]);

      fieldError(await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 0 }), 'tutar');
      fieldError(await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 10, paraBirimi: 'EUR' }), 'kur');

      await setFlow(db, chainOf(admin.id));
      const nobody = await call(admin, 'POST', '/api/onay-akisi/onizle', { tutar: 100 });
      expect(nobody.status).toBe(200);
      expect(nobody.body).toEqual({ onayTutari: 100, paraBirimi: 'TRY', akis: expect.objectContaining({ ad: 'Genel' }), adimlar: [], uyari: expect.any(String) });
      expectError(await call(admin, 'POST', '/api/masraflar', { ...formBody(), gonder: true }), 409, 'onaylayan_yok');
      const draft = await create(admin, {}, false);
      expectError(await act(admin, draft.id, 'gonder'), 409, 'onaylayan_yok');
    });

    it("previews the user's own flow; only an administrator may name another flow", async () => {
      const satis = await makeFlow(db, 'Satış', chainOf(b.id));
      await assignFlow(db, owner.id, satis);
      const own = await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 100 });
      expect(own.body).toMatchObject({ akis: { id: satis, ad: 'Satış', varsayilan: false }, adimlar: [{ onayci: { id: b.id } }] });
      expectError(await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 100, akisId: satis }), 403, 'yetki_yok');
      const tried = await call(admin, 'POST', '/api/onay-akisi/onizle', { tutar: 100, akisId: satis });
      expect(tried.body).toMatchObject({ akis: { id: satis }, adimlar: [{ onayci: { id: b.id }, durum: 'sirada' }] });
      expectError(await call(admin, 'POST', '/api/onay-akisi/onizle', { tutar: 100, akisId: 999_999 }), 404, 'bulunamadi');
      fieldError(await call(admin, 'POST', '/api/onay-akisi/onizle', { tutar: 100, akisId: 0 }), 'akisId');
    });

    it('previews a named flow by its own strategy', async () => {
      const steps = [
        { onayciId: a.id, limit: 5000 },
        { onayciId: b.id, limit: null },
      ];
      const zincir = await makeFlow(db, 'Zincir', steps, 'zincir');
      const tek = await makeFlow(db, 'Tek', steps, 'tek');
      const approvers = async (akisId: number, tutar: number): Promise<number[]> => {
        const res = await call(admin, 'POST', '/api/onay-akisi/onizle', { tutar, akisId });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.akis.id).toBe(akisId);
        return res.body.adimlar.map((s: { onayci: { id: number } }) => s.onayci.id);
      };
      expect(await approvers(zincir, 5000)).toEqual([a.id]);
      expect(await approvers(zincir, 5000.01)).toEqual([a.id, b.id]);
      expect(await approvers(tek, 5000)).toEqual([a.id]);
      expect(await approvers(tek, 5000.01)).toEqual([b.id]);
    });
  });

  describe('CSV export', () => {
    it('is for accounting and administrators only', async () => {
      expectError(await call(owner, 'GET', '/api/masraflar/disa-aktar'), 403, 'yetki_yok');
      await setFlow(db, chainOf(a.id));
      expectError(await call(a, 'GET', '/api/masraflar/disa-aktar'), 403, 'yetki_yok');
      fieldError(await call(accounting, 'GET', '/api/masraflar/disa-aktar?baslangic=2025-13-01'), 'baslangic');
      fieldError(await call(accounting, 'GET', '/api/masraflar/disa-aktar?durum=hepsi'), 'durum');
    });

    it('writes UTF-8 with a BOM, semicolons, quoted cells and no live formulas', async () => {
      const f1 = await create(owner, { baslik: '=HYPERLINK("http://kotu.example","tıkla")', satici: '+90 212 555 00 00', tutar: 1234.5 }, false);
      const f2 = await create(owner, { baslik: 'Yemek; içecek', satici: '@SUM(A1)' }, false);
      const f3 = await create(owner, { baslik: '-2+3', satici: 'Çarşı "Merkez"', masrafTarihi: '2025-06-16' }, false);

      const res = await fetch(`${base}/api/masraflar/disa-aktar`, { headers: { Authorization: `Bearer ${tokenOf(accounting)}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="?masraflar-\d{4}-\d{2}-\d{2}\.csv"?$/);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

      const lines = bytes.toString('utf8').slice(1).split('\r\n');
      expect(lines.at(-1)).toBe('');
      expect(lines[0]).toBe('No;Başlık;Kategori;Masraf tarihi;Satıcı;Fatura no;Tutar;Para birimi;Kur;Yerel tutar;Durum;Oluşturan;Departman;Gönderim;Sonuçlanma;Ödeme');
      expect(lines.slice(1, -1)).toEqual([
        `${f1.id};"'=HYPERLINK(""http://kotu.example"",""tıkla"")";Yemek;2025-06-15;'+90 212 555 00 00;;1234,50;TRY;;1234,50;Taslak;Form Sahibi;;;;`,
        `${f2.id};"Yemek; içecek";Yemek;2025-06-15;'@SUM(A1);;100,00;TRY;;100,00;Taslak;Form Sahibi;;;;`,
        `${f3.id};'-2+3;Yemek;2025-06-16;"Çarşı ""Merkez""";;100,00;TRY;;100,00;Taslak;Form Sahibi;;;;`,
      ]);
    });

    it('filters by state and expense date', async () => {
      await setFlow(db, chainOf(a.id));
      const jan = await create(owner, { masrafTarihi: '2025-01-10' }, false);
      const feb = await create(owner, { masrafTarihi: '2025-02-10' });
      const ids = async (query: string): Promise<number[]> => {
        const res = await call(admin, 'GET', `/api/masraflar/disa-aktar${query}`);
        expect(res.status).toBe(200);
        return (res.body as string)
          .split('\r\n')
          .slice(1, -1)
          .map((line) => Number(line.split(';')[0]));
      };
      expect(await ids('')).toEqual([jan.id, feb.id]);
      expect(await ids('?durum=onayda')).toEqual([feb.id]);
      expect(await ids('?baslangic=2025-02-01')).toEqual([feb.id]);
      expect(await ids('?bitis=2025-01-31')).toEqual([jan.id]);
      expect(await ids('?durum=odendi')).toEqual([]);
    });
  });

  describe('invoice access', () => {
    it('shows employees only the invoices they uploaded', async () => {
      const mine = await upload(owner, 'pdf');
      const theirs = await upload(outsider, 'png');
      const list = async (who: Kullanici): Promise<string[]> => (await call(who, 'GET', '/api/invoices')).body.map((r: { id: string }) => r.id).sort();
      expect(await list(owner)).toEqual([mine.id]);
      expect(await list(outsider)).toEqual([theirs.id]);
      expect(await list(a)).toEqual([]);
      expect(await list(accounting)).toEqual([mine.id, theirs.id].sort());
      expect(await list(admin)).toEqual([mine.id, theirs.id].sort());

      expectError(await call(outsider, 'GET', `/api/invoices/${mine.id}`), 404, 'bulunamadi');
      expectError(await call(outsider, 'GET', `/api/invoices/${mine.id}/dosya`), 404, 'bulunamadi');
      expectError(await call(owner, 'GET', `/api/invoices/${theirs.id}/dosya`), 404, 'bulunamadi');
      expectError(await call(owner, 'GET', '/api/invoices/abc/dosya'), 404, 'bulunamadi');

      expect((await call(owner, 'GET', `/api/invoices/${mine.id}`)).body.fatura.faturaNo).toBe('ABC2026000000123');
      expect((await call(accounting, 'GET', `/api/invoices/${theirs.id}`)).status).toBe(200);
    });

    it('serves the original file with its type, nosniff and the file name', async () => {
      const pdf = await upload(owner, 'pdf');
      const png = await upload(owner, 'png');
      const get = (id: string, who: Kullanici = owner) => fetch(`${base}/api/invoices/${id}/dosya`, { headers: { Authorization: `Bearer ${tokenOf(who)}` } });

      const pdfRes = await get(pdf.id);
      expect(pdfRes.status).toBe(200);
      expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
      expect(pdfRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(pdfRes.headers.get('content-disposition')).toBe(`inline; filename="Fi_ Ekim.pdf"; filename*=UTF-8''${encodeURIComponent('Fiş Ekim.pdf')}`);
      expect(Buffer.from(await pdfRes.arrayBuffer()).equals(pdf.bytes)).toBe(true);

      const pngRes = await get(png.id, accounting);
      expect(pngRes.status).toBe(200);
      expect(pngRes.headers.get('content-type')).toBe('image/png');
      expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await pngRes.arrayBuffer()).equals(png.bytes)).toBe(true);

      // Records kept from before files were stored answer 404 dosya_yok.
      const old = await makeInvoice(db, owner.id, {}, null);
      expect((await call(owner, 'GET', `/api/invoices/${old}`)).status).toBe(200);
      expectError(await call(owner, 'GET', `/api/invoices/${old}/dosya`), 404, 'dosya_yok');
    });

    it("opens a form's invoice to its approvers, routed by the invoice total, and to nobody else", async () => {
      await setFlow(
        db,
        [
          { onayciId: a.id, limit: 5000 },
          { onayciId: b.id, limit: null },
        ],
        'tek',
      );
      const invoice = await upload(owner, 'pdf', { genelToplam: 6000 });
      const f = await create(owner, { tutar: 4000, faturaIdler: [invoice.id] });
      expect(f).toMatchObject({ onayTutari: 6000, tutarFarki: { fatura: 6000, beyan: 4000 }, siradakiOnayci: { id: b.id } });
      expect(f.faturalar).toEqual([
        expect.objectContaining({ id: invoice.id, dosyaAdi: 'Fiş Ekim.pdf', dosyaVar: true, mime: 'application/pdf', genelToplam: 6000, paraBirimi: 'TRY' }),
      ]);

      expect((await call(b, 'GET', `/api/invoices/${invoice.id}`)).status).toBe(200);
      const file = await fetch(`${base}/api/invoices/${invoice.id}/dosya`, { headers: { Authorization: `Bearer ${tokenOf(b)}` } });
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('application/pdf');
      // The approver may open it but it is not in their own list.
      expect((await call(b, 'GET', '/api/invoices')).body).toEqual([]);

      expectError(await call(a, 'GET', `/api/invoices/${invoice.id}`), 404, 'bulunamadi');
      expectError(await call(a, 'GET', `/api/invoices/${invoice.id}/dosya`), 404, 'bulunamadi');
      expectError(await call(outsider, 'GET', `/api/invoices/${invoice.id}/dosya`), 404, 'bulunamadi');
    });

    it('keeps multi-file queues and the live monitor to their sender; accounting and administrators see all', async () => {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(Buffer.concat([PDF_BYTES, Buffer.from(`\n% toplu ${Date.now()}\n`)]))]), 'toplu.pdf');
      const sent = await fetch(`${base}/api/invoices/toplu`, { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(owner)}` }, body: form });
      expect([200, 202]).toContain(sent.status);
      const queueId = ((await sent.json()) as { id: string }).id;
      // Let the background read finish before the next test empties the database.
      for (let i = 0; i < 100 && (await call(owner, 'GET', `/api/invoices/toplu/${queueId}`)).body.bitti !== true; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await call(owner, 'GET', `/api/invoices/toplu/${queueId}`)).body.bitti).toBe(true);
      expectError(await call(outsider, 'GET', `/api/invoices/toplu/${queueId}`), 404, 'bulunamadi');
      expect((await call(accounting, 'GET', `/api/invoices/toplu/${queueId}`)).status).toBe(200);
      expect((await call(admin, 'GET', `/api/invoices/toplu/${queueId}`)).status).toBe(200);

      await upload(outsider, 'png');
      const senders = async (who: Kullanici): Promise<number[]> =>
        (await call(who, 'GET', '/api/izleme')).body.etkinlikler.map((e: { kullanici: { id: number } | null }) => e.kullanici?.id ?? 0);
      expect(await senders(owner)).toEqual([owner.id]);
      expect(await senders(outsider)).toEqual([outsider.id]);
      expect(await senders(a)).toEqual([]);
      expect((await senders(accounting)).sort()).toEqual([owner.id, outsider.id].sort());
    });

    it('attaches only own uploads, once per live form; a cancelled form frees the invoice', async () => {
      await setFlow(db, chainOf(a.id));
      const invoice = await upload(owner, 'pdf');
      fieldError(await call(outsider, 'POST', '/api/masraflar', formBody({ faturaIdler: [invoice.id] })), 'faturaIdler');

      const first = await create(owner, { faturaIdler: [invoice.id] }, false);
      const used = await call(owner, 'POST', '/api/masraflar', formBody({ faturaIdler: [invoice.id] }));
      expectError(used, 409, 'fatura_kullaniliyor');
      expect(used.body.hata.alanlar).toEqual({ 'faturaIdler.0': `Bu fatura #${first.id} numaralı masraf formunda kullanılıyor.` });
      const second = await create(owner, {}, false);
      expectError(await call(owner, 'PATCH', `/api/masraflar/${second.id}`, { faturaIdler: [invoice.id] }), 409, 'fatura_kullaniliyor');

      expect((await act(owner, first.id, 'iptal')).body.durum).toBe('iptal');
      const attached = await call(owner, 'PATCH', `/api/masraflar/${second.id}`, { faturaIdler: [invoice.id] });
      expect(attached.status).toBe(200);
      expect(attached.body.faturaIdler).toEqual([invoice.id]);
      // The owner of the cancelled form still sees the invoice it held.
      expect((await call(owner, 'GET', `/api/masraflar/${first.id}`)).body.faturalar).toEqual([expect.objectContaining({ id: invoice.id })]);

      // Uploading the same file again gives the second employee access to the stored record, not to the form.
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(invoice.bytes)]), 'kopya.pdf');
      const again = await fetch(`${base}/api/invoices`, { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(outsider)}` }, body: form });
      expect(again.status).toBe(200);
      expect(again.headers.get('x-fatura-id')).toBe(invoice.id);
      expect((await call(outsider, 'GET', `/api/invoices/${invoice.id}`)).status).toBe(200);
      expectError(await call(outsider, 'POST', '/api/masraflar', formBody({ faturaIdler: [invoice.id] })), 409, 'fatura_kullaniliyor');
      expectError(await call(outsider, 'GET', `/api/masraflar/${second.id}`), 404, 'bulunamadi');
    });

    it('asks for the base-currency equivalent of an invoice in another currency', async () => {
      await setFlow(
        db,
        [
          { onayciId: a.id, limit: 5000 },
          { onayciId: b.id, limit: null },
        ],
        'tek',
      );
      const usd = await upload(owner, 'pdf', { genelToplam: 200, paraBirimi: 'USD' });
      fieldError(await call(owner, 'POST', '/api/masraflar', formBody({ faturaIdler: [usd.id], yerelKarsiliklar: { [usd.id]: 0 } })), `yerelKarsiliklar.${usd.id}`);
      fieldError(await call(owner, 'POST', '/api/masraflar', formBody({ faturaIdler: [usd.id], yerelKarsiliklar: { abc: 10 } })), 'yerelKarsiliklar.abc');
      fieldError(await call(owner, 'POST', '/api/masraflar', formBody({ faturaIdler: [usd.id], yerelKarsiliklar: [6500] })), 'yerelKarsiliklar');

      const refused = await call(owner, 'POST', '/api/masraflar', { ...formBody({ tutar: 100, faturaIdler: [usd.id] }), gonder: true });
      expectError(refused, 409, 'karsilik_eksik');
      expect(refused.body.hata.alanlar).toEqual({ [`yerelKarsiliklar.${usd.id}`]: 'Fatura USD cinsinden; onaya göndermek için TRY karşılığını girin.' });

      const preview = await call(owner, 'POST', '/api/onay-akisi/onizle', { tutar: 100, faturaIdler: [usd.id], yerelKarsiliklar: { [usd.id]: 6500 } });
      expect(preview.body.onayTutari).toBe(6500);
      const f = await create(owner, { tutar: 100, faturaIdler: [usd.id], yerelKarsiliklar: { [usd.id]: 6500 } });
      expect(f).toMatchObject({ onayTutari: 6500, siradakiOnayci: { id: b.id }, tutarFarki: { fatura: 6500, beyan: 100 } });
      expect(f.faturalar).toEqual([expect.objectContaining({ id: usd.id, paraBirimi: 'USD', karsilikGerekli: true, yerelKarsilik: 6500 })]);
    });

    it('opens an invoice to whoever approves its form now, and closes it when it leaves the form', async () => {
      await setFlow(db, chainOf(a.id));
      const kept = await upload(owner, 'pdf');
      const dropped = await upload(owner, 'png');
      const f = await create(owner, { faturaIdler: [kept.id, dropped.id] });
      const sees = async (who: Kullanici, id: string): Promise<number> => (await call(who, 'GET', `/api/invoices/${id}`)).status;
      expect([await sees(a, kept.id), await sees(a, dropped.id)]).toEqual([200, 200]);

      // A reassigned approver loses the invoices with the form; the new one gets them.
      expect((await act(admin, f.id, 'devret', { onayId: f.onaylar[0].id, yeniOnayciId: b.id })).status).toBe(200);
      expect([await sees(a, kept.id), await sees(b, kept.id), await sees(b, dropped.id)]).toEqual([404, 200, 200]);

      // An invoice taken off the form is no longer the approver's to open.
      await act(owner, f.id, 'geri-cek');
      expect((await call(owner, 'PATCH', `/api/masraflar/${f.id}`, { faturaIdler: [kept.id] })).status).toBe(200);
      expect([await sees(b, kept.id), await sees(b, dropped.id), await sees(owner, dropped.id)]).toEqual([200, 404, 200]);

      // A cancelled form still shows its invoice to the people who handled it.
      expect((await act(owner, f.id, 'iptal')).body.durum).toBe('iptal');
      expect([await sees(b, kept.id), await sees(owner, kept.id), await sees(outsider, kept.id)]).toEqual([200, 200, 404]);
    });

    it('takes several invoices on one form, opens each to the approvers and routes by their sum', async () => {
      await setFlow(
        db,
        [
          { onayciId: a.id, limit: 5000 },
          { onayciId: b.id, limit: null },
        ],
        'tek',
      );
      const hotel = await upload(owner, 'pdf', { genelToplam: 3000 });
      const taxi = await upload(owner, 'png', { genelToplam: 2500 });
      const f = await create(owner, { tutar: 4000, faturaIdler: [hotel.id, taxi.id] });
      expect(f).toMatchObject({ onayTutari: 5500, tutarFarki: { fatura: 5500, beyan: 4000 }, siradakiOnayci: { id: b.id }, faturaIdler: [hotel.id, taxi.id] });
      expect(f.faturalar.map((x: { id: string; mime: string }) => [x.id, x.mime])).toEqual([
        [hotel.id, 'application/pdf'],
        [taxi.id, 'image/png'],
      ]);
      for (const id of [hotel.id, taxi.id]) {
        expect((await call(b, 'GET', `/api/invoices/${id}`)).status).toBe(200);
        expectError(await call(a, 'GET', `/api/invoices/${id}`), 404, 'bulunamadi');
      }
      const listed = await call(owner, 'GET', '/api/masraflar');
      expect(listed.body.kayitlar[0].faturaIdler).toEqual([hotel.id, taxi.id]);

      // Withdraw, drop one invoice and resend: the smaller sum goes to the lower tier.
      await act(owner, f.id, 'geri-cek');
      const edited = await call(owner, 'PATCH', `/api/masraflar/${f.id}`, { faturaIdler: [taxi.id] });
      expect(edited.body).toMatchObject({ faturaIdler: [taxi.id], tutarFarki: { fatura: 2500, beyan: 4000 } });
      const resent = await act(owner, f.id, 'gonder');
      expect(resent.body).toMatchObject({ onayTutari: 4000, siradakiOnayci: { id: a.id } });
      // The hotel invoice left the form: free for another one.
      expect((await create(owner, { faturaIdler: [hotel.id] }, false)).faturaIdler).toEqual([hotel.id]);
    });
  });
});
