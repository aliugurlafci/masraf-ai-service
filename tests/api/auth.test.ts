// Signing in, sessions and the account endpoints over HTTP (docs/onay-sistemi.md, sections 5 and 6).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, DEFAULT_AUTH } from '../../src/api/app.ts';
import type { ExtractInvoice } from '../../src/claude/extractor.ts';
import { execute, p, queryOne, type Db } from '../../src/db/sql.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { sampleExtraction } from '../helpers.ts';
import { chainOf, closeTestDb, defaultFlowId, makeUser, resetDb, setFlow, testDb, TEST_PASSWORD, tokenFor } from '../db.ts';

const MAX_ATTEMPTS = 3;
const SESSION_SECONDS = DEFAULT_AUTH.sessionTtlMs / 1000;

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
}

interface CallOptions {
  readonly token?: string;
  readonly cookie?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
}

describe('sessions and account endpoints', () => {
  let db: Db;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);

  beforeEach(async () => {
    await resetDb(db);
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const extract = vi.fn<ExtractInvoice>(async () => sampleExtraction());
    server.on('request', createApp({ extract, db, maxFileBytes: 1024 * 1024, port, log: () => {}, auth: { ...DEFAULT_AUTH, loginMaxAttempts: MAX_ATTEMPTS } }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = async (method: string, path: string, opts: CallOptions = {}): Promise<Answer> => {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
    const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text === '' ? null : JSON.parse(text) };
  };

  const login = (eposta: string, sifre = TEST_PASSWORD, istemci?: string): Promise<Answer> =>
    call('POST', '/api/oturum', { body: istemci === undefined ? { eposta, sifre } : { eposta, sifre, istemci } });

  /** "masraf_oturum=<token>" from a panel login answer. */
  const cookieOf = (res: Answer): string => {
    const [cookie] = res.headers.getSetCookie();
    return (cookie ?? '').split(';')[0] ?? '';
  };

  const expectError = (res: Answer, status: number, kod: string): void => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body).toMatchObject({ hata: { kod, mesaj: expect.any(String) } });
  };

  describe('signing in', () => {
    it('gives the panel an HttpOnly SameSite=Strict cookie and never the token', async () => {
      const user = await makeUser(db, { eposta: 'panel@firma.test', adSoyad: 'Panel Kullanıcısı' });
      const res = await login('Panel@Firma.TEST', TEST_PASSWORD, 'panel');
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('token');
      expect(res.body).toEqual({
        bitis: expect.any(String),
        kullanici: expect.objectContaining({ id: user.id, eposta: 'panel@firma.test', adSoyad: 'Panel Kullanıcısı', sonGiris: expect.any(String) }),
      });
      expect(res.body.kullanici).not.toHaveProperty('sifreOzeti');

      const cookies = res.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      const [cookie = ''] = cookies;
      const token = /^masraf_oturum=([A-Za-z0-9_-]{43});/.exec(cookie)?.[1] ?? '';
      expect(token).not.toBe('');
      const attributes = cookie.split(';').map((s) => s.trim().toLowerCase());
      expect(attributes).toContain('httponly');
      expect(attributes).toContain('samesite=strict');
      expect(attributes).toContain('path=/');
      expect(attributes).toContain(`max-age=${SESSION_SECONDS}`);
      expect(JSON.stringify(res.body)).not.toContain(token);

      const me = await call('GET', '/api/ben', { cookie: cookieOf(res) });
      expect(me.status).toBe(200);
      expect(me.body.kullanici.id).toBe(user.id);
      const row = await queryOne<{ istemci: string }>(db, 'SELECT istemci FROM dbo.oturumlar WHERE kullanici_id = @k', { k: p.int(user.id) });
      expect(row?.istemci).toBe('panel');
    });

    it('gives mobile and API clients the token in the body; api is the default', async () => {
      const user = await makeUser(db, { eposta: 'mobil@firma.test' });
      const mobile = await login('mobil@firma.test', TEST_PASSWORD, 'mobil');
      expect(mobile.status).toBe(200);
      expect(mobile.body).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), bitis: expect.any(String), kullanici: expect.objectContaining({ id: user.id }) });
      expect(mobile.headers.getSetCookie()).toEqual([]);
      expect((await call('GET', '/api/ben', { token: mobile.body.token })).status).toBe(200);

      const plain = await login('mobil@firma.test');
      expect(plain.status).toBe(200);
      expect(typeof plain.body.token).toBe('string');
      const clients = await queryOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM dbo.oturumlar WHERE kullanici_id = @k AND istemci IN ('mobil', 'api')`,
        { k: p.int(user.id) },
      );
      expect(clients?.n).toBe(2);
      // The bitis of the answer is about a session length away.
      expect(Date.parse(plain.body.bitis) - Date.now()).toBeGreaterThan(DEFAULT_AUTH.sessionTtlMs - 60_000);
    });

    it('answers a wrong password and an unknown e-mail alike with 401 hatali_giris', async () => {
      await makeUser(db, { eposta: 'var@firma.test' });
      const wrong = await login('var@firma.test', 'Yanlis1234');
      const unknown = await login('yok@firma.test', 'Yanlis1234');
      expectError(wrong, 401, 'hatali_giris');
      expectError(unknown, 401, 'hatali_giris');
      expect(unknown.body).toEqual(wrong.body);
    });

    it('refuses an inactive account with 403 hesap_pasif, but only after the right password', async () => {
      await makeUser(db, { eposta: 'pasif@firma.test', aktif: false });
      expectError(await login('pasif@firma.test'), 403, 'hesap_pasif');
      expectError(await login('pasif@firma.test', 'Yanlis1234'), 401, 'hatali_giris');
    });

    it('locks the e-mail with 429 after too many failed attempts, even for the right password', async () => {
      await makeUser(db, { eposta: 'kilit@firma.test' });
      await makeUser(db, { eposta: 'diger@firma.test' });
      for (let i = 0; i < MAX_ATTEMPTS; i++) expectError(await login('kilit@firma.test', 'Yanlis1234'), 401, 'hatali_giris');
      const locked = await login('kilit@firma.test');
      expectError(locked, 429, 'cok_fazla_deneme');
      expect(locked.body.hata.mesaj).toContain('dakika');
      expectError(await login('KILIT@firma.test'), 429, 'cok_fazla_deneme');
      // Other addresses are not affected.
      expect((await login('diger@firma.test')).status).toBe(200);
      // Unknown addresses are counted the same way.
      for (let i = 0; i < MAX_ATTEMPTS; i++) await login('yok@firma.test', 'Yanlis1234');
      expectError(await login('yok@firma.test', 'Yanlis1234'), 429, 'cok_fazla_deneme');
    });

    it('starts counting again after a successful login', async () => {
      await makeUser(db, { eposta: 'unutkan@firma.test' });
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expectError(await login('unutkan@firma.test', 'Yanlis1234'), 401, 'hatali_giris');
        expect((await login('unutkan@firma.test')).status).toBe(200);
      }
    });

    it('validates the login body', async () => {
      const missing = await call('POST', '/api/oturum', { body: { eposta: 'a@firma.test' } });
      expectError(missing, 400, 'gecersiz_istek');
      expect(missing.body.hata.alanlar).toHaveProperty('sifre');
      const client = await call('POST', '/api/oturum', { body: { eposta: 'a@firma.test', sifre: 'x', istemci: 'tarayici' } });
      expectError(client, 400, 'gecersiz_istek');
      expect(client.body.hata.alanlar).toHaveProperty('istemci');
      expectError(await call('POST', '/api/oturum', { rawBody: '{"eposta":' }), 400, 'gecersiz_json');
    });
  });

  describe('sessions', () => {
    it('requires a session on every /api endpoint except signing in; /health stays open', async () => {
      const endpoints: Array<[string, string]> = [
        ['GET', '/api/ben'],
        ['PUT', '/api/ben/sifre'],
        ['DELETE', '/api/oturum'],
        ['GET', '/api/ozet'],
        ['GET', '/api/masraflar'],
        ['POST', '/api/masraflar'],
        ['GET', '/api/masraflar/1001'],
        ['GET', '/api/masraflar/disa-aktar'],
        ['GET', '/api/onaylar'],
        ['POST', '/api/onay-akisi/onizle'],
        ['GET', '/api/onay-akislari'],
        ['GET', '/api/kullanicilar'],
        ['GET', '/api/kategoriler'],
        ['GET', '/api/invoices'],
        ['POST', '/api/invoices'],
        ['GET', '/api/izleme'],
        ['GET', '/api/bilinmeyen'],
      ];
      for (const [method, path] of endpoints) {
        const res = await call(method, path);
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.body.hata.kod, `${method} ${path}`).toBe('oturum_gerekli');
      }
      expect((await call('GET', '/health')).status).toBe(200);
    });

    it("renews the panel's cookie whenever the session is extended, never for bearer tokens", async () => {
      await makeUser(db, { eposta: 'kayan@firma.test' });
      const cookie = cookieOf(await login('kayan@firma.test', TEST_PASSWORD, 'panel'));
      const token = (await login('kayan@firma.test', TEST_PASSWORD, 'mobil')).body.token as string;

      // Used within the last minutes: nothing to extend.
      expect((await call('GET', '/api/ben', { cookie })).headers.getSetCookie()).toEqual([]);

      await execute(db, 'UPDATE dbo.oturumlar SET son_erisim = DATEADD(MINUTE, -10, SYSUTCDATETIME())');
      const renewed = await call('GET', '/api/ben', { cookie });
      expect(renewed.status).toBe(200);
      const [set] = renewed.headers.getSetCookie();
      expect(set).toContain(cookie);
      expect(set).toMatch(new RegExp(`Max-Age=${SESSION_SECONDS}`));
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/SameSite=Strict/);

      const viaBearer = await call('GET', '/api/ben', { token });
      expect(viaBearer.status).toBe(200);
      expect(viaBearer.headers.getSetCookie()).toEqual([]);
    });

    it('refuses malformed, unknown, expired and inactive users’ tokens', async () => {
      const user = await makeUser(db);
      expectError(await call('GET', '/api/ben', { token: 'abc' }), 401, 'oturum_gerekli');
      expectError(await call('GET', '/api/ben', { token: 'A'.repeat(43) }), 401, 'oturum_gerekli');
      expectError(await call('GET', '/api/ben', { cookie: 'masraf_oturum=' }), 401, 'oturum_gerekli');

      const expired = await tokenFor(db, user.id);
      await execute(db, 'UPDATE dbo.oturumlar SET son_kullanma = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE kullanici_id = @k', { k: p.int(user.id) });
      expectError(await call('GET', '/api/ben', { token: expired }), 401, 'oturum_gerekli');

      const live = await tokenFor(db, user.id);
      expect((await call('GET', '/api/ben', { token: live })).status).toBe(200);
      await execute(db, 'UPDATE dbo.kullanicilar SET aktif = 0 WHERE id = @k', { k: p.int(user.id) });
      expectError(await call('GET', '/api/ben', { token: live }), 401, 'oturum_gerekli');
    });

    it('ends only the current session on logout and clears the cookie', async () => {
      await makeUser(db, { eposta: 'cikis@firma.test' });
      const panel = await login('cikis@firma.test', TEST_PASSWORD, 'panel');
      const mobile = await login('cikis@firma.test', TEST_PASSWORD, 'mobil');
      const cookie = cookieOf(panel);

      const out = await call('DELETE', '/api/oturum', { cookie });
      expect(out.status).toBe(204);
      const [cleared = ''] = out.headers.getSetCookie();
      expect(cleared).toMatch(/^masraf_oturum=;/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expectError(await call('GET', '/api/ben', { cookie }), 401, 'oturum_gerekli');

      expect((await call('GET', '/api/ben', { token: mobile.body.token })).status).toBe(200);
      expect((await call('DELETE', '/api/oturum', { token: mobile.body.token })).status).toBe(204);
      expectError(await call('GET', '/api/ben', { token: mobile.body.token }), 401, 'oturum_gerekli');
    });

    it('returns the user and the pending approval count from GET /api/ben', async () => {
      const approver = await makeUser(db, { adSoyad: 'Onaycı', departman: 'Finans' });
      const sender = await makeUser(db);
      await setFlow(db, chainOf(approver.id));
      const senderToken = await tokenFor(db, sender.id);
      for (let i = 0; i < 2; i++) {
        const sent = await call('POST', '/api/masraflar', {
          token: senderToken,
          body: { baslik: `Yemek ${i}`, kategoriId: 1, masrafTarihi: '2025-06-15', tutar: 100, gonder: true },
        });
        expect(sent.status).toBe(201);
      }
      const me = await call('GET', '/api/ben', { token: await tokenFor(db, approver.id) });
      expect(me.status).toBe(200);
      const genel = await defaultFlowId(db);
      expect(me.body).toEqual({
        kullanici: expect.objectContaining({
          id: approver.id,
          adSoyad: 'Onaycı',
          rol: 'calisan',
          departman: 'Finans',
          aktif: true,
          sifreDegismeli: false,
          onayAkisiId: null,
          onayAkisi: { id: genel, ad: 'Genel', varsayilan: true },
          onaycilik: [{ akis: { id: genel, ad: 'Genel', strateji: 'zincir' }, sira: 1, limit: null, altLimit: 0, ustLimit: null }],
        }),
        bekleyenOnay: 2,
      });
      expect((await call('GET', '/api/ben', { token: senderToken })).body.bekleyenOnay).toBe(0);
    });

    it('shows the company figures in GET /api/ozet only to accounting and administrators', async () => {
      const employee = await makeUser(db);
      const accounting = await makeUser(db, { rol: 'muhasebe' });
      const mine = await call('GET', '/api/ozet', { token: await tokenFor(db, employee.id) });
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual({
        paraBirimi: 'TRY',
        benim: { taslak: 0, onayda: 0, onaylandi: 0, reddedildi: 0, odendi: 0, buAyToplam: 0, bekleyenTutar: 0 },
        bekleyenOnay: 0,
        sonMasraflar: [],
        genel: null,
      });
      const company = await call('GET', '/api/ozet', { token: await tokenFor(db, accounting.id) });
      expect(company.body.genel).toEqual({ onayda: 0, odemeBekleyen: 0, odemeBekleyenTutar: 0, buAyOnaylanan: 0 });
    });
  });

  describe('passwords', () => {
    it('lets a user who must change the password only see themselves, change it and sign out', async () => {
      await makeUser(db, { eposta: 'yeni@firma.test', sifreDegismeli: true });
      const res = await login('yeni@firma.test');
      expect(res.body.kullanici.sifreDegismeli).toBe(true);
      const token: string = res.body.token;

      expect((await call('GET', '/api/ben', { token })).status).toBe(200);
      const blocked: Array<[string, string]> = [
        ['GET', '/api/ozet'],
        ['GET', '/api/masraflar'],
        ['POST', '/api/masraflar'],
        ['GET', '/api/onaylar'],
        ['POST', '/api/onay-akisi/onizle'],
        ['GET', '/api/kategoriler'],
        ['GET', '/api/invoices'],
        ['POST', '/api/invoices'],
        ['GET', '/api/izleme'],
      ];
      for (const [method, path] of blocked) {
        const answer = await call(method, path, method === 'GET' ? { token } : { token, body: {} });
        expect(answer.status, `${method} ${path}`).toBe(403);
        expect(answer.body.hata.kod, `${method} ${path}`).toBe('sifre_degismeli');
      }

      // The password endpoint is open to them, with its own checks.
      expectError(await call('PUT', '/api/ben/sifre', { token, body: { mevcutSifre: 'Yanlis1234', yeniSifre: 'YeniSifre2026' } }), 400, 'hatali_sifre');
      expect((await call('PUT', '/api/ben/sifre', { token, body: { mevcutSifre: TEST_PASSWORD, yeniSifre: 'YeniSifre2026' } })).status).toBe(204);
      expect((await call('GET', '/api/ozet', { token })).status).toBe(200);
      expect((await call('GET', '/api/ben', { token })).body.kullanici.sifreDegismeli).toBe(false);
    });

    it('lets a user who must change the password sign out', async () => {
      await makeUser(db, { eposta: 'kapat@firma.test', sifreDegismeli: true });
      const token: string = (await login('kapat@firma.test')).body.token;
      expect((await call('DELETE', '/api/oturum', { token })).status).toBe(204);
      expectError(await call('GET', '/api/ben', { token }), 401, 'oturum_gerekli');
    });

    it('ends every other session when the password changes', async () => {
      await makeUser(db, { eposta: 'degis@firma.test' });
      const mobile: string = (await login('degis@firma.test', TEST_PASSWORD, 'mobil')).body.token;
      const panel = cookieOf(await login('degis@firma.test', TEST_PASSWORD, 'panel'));

      expect((await call('PUT', '/api/ben/sifre', { token: mobile, body: { mevcutSifre: TEST_PASSWORD, yeniSifre: 'YeniSifre2026' } })).status).toBe(204);
      expect((await call('GET', '/api/ben', { token: mobile })).status).toBe(200);
      expectError(await call('GET', '/api/ben', { cookie: panel }), 401, 'oturum_gerekli');
      expectError(await login('degis@firma.test'), 401, 'hatali_giris');
      expect((await login('degis@firma.test', 'YeniSifre2026')).status).toBe(200);
    });

    it('refuses a wrong current password and weak or missing new ones', async () => {
      const user = await makeUser(db);
      const token = await tokenFor(db, user.id);
      const wrong = await call('PUT', '/api/ben/sifre', { token, body: { mevcutSifre: 'Yanlis1234', yeniSifre: 'YeniSifre2026' } });
      expectError(wrong, 400, 'hatali_sifre');
      expect(wrong.body.hata.alanlar).toHaveProperty('mevcutSifre');
      const weak = await call('PUT', '/api/ben/sifre', { token, body: { mevcutSifre: TEST_PASSWORD, yeniSifre: 'kisa' } });
      expectError(weak, 400, 'gecersiz_istek');
      expect(weak.body.hata.alanlar).toHaveProperty('yeniSifre');
      const same = await call('PUT', '/api/ben/sifre', { token, body: { mevcutSifre: TEST_PASSWORD, yeniSifre: TEST_PASSWORD } });
      expectError(same, 400, 'gecersiz_istek');
      const missing = await call('PUT', '/api/ben/sifre', { token, body: {} });
      expectError(missing, 400, 'gecersiz_istek');
      expect(Object.keys(missing.body.hata.alanlar).sort()).toEqual(['mevcutSifre', 'yeniSifre']);
      expect((await call('GET', '/api/ben', { token })).status).toBe(200);
    });

    it("ends the user's sessions when an administrator resets the password, and forces a change", async () => {
      const admin = await makeUser(db, { rol: 'yonetici' });
      const user: Kullanici = await makeUser(db, { eposta: 'sifirla@firma.test' });
      const adminToken = await tokenFor(db, admin.id);
      const userToken = await tokenFor(db, user.id);

      expectError(await call('POST', `/api/kullanicilar/${admin.id}/sifre`, { token: userToken, body: { yeniSifre: 'YeniSifre2026' } }), 403, 'yetki_yok');
      const weak = await call('POST', `/api/kullanicilar/${user.id}/sifre`, { token: adminToken, body: { yeniSifre: 'kisa' } });
      expectError(weak, 400, 'gecersiz_istek');
      expect((await call('GET', '/api/ben', { token: userToken })).status).toBe(200);

      expect((await call('POST', `/api/kullanicilar/${user.id}/sifre`, { token: adminToken, body: { yeniSifre: 'YeniSifre2026' } })).status).toBe(204);
      expectError(await call('GET', '/api/ben', { token: userToken }), 401, 'oturum_gerekli');
      expect((await call('GET', '/api/ben', { token: adminToken })).status).toBe(200);
      expectError(await login('sifirla@firma.test'), 401, 'hatali_giris');
      const again = await login('sifirla@firma.test', 'YeniSifre2026');
      expect(again.body.kullanici.sifreDegismeli).toBe(true);
      expectError(await call('GET', '/api/masraflar', { token: again.body.token }), 403, 'sifre_degismeli');
    });
  });
});
