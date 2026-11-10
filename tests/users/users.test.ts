// Users and the approval flow store against the test database (docs/onay-sistemi.md, sections 2 and 6).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFlow, deleteFlow, getFlow as getFlowById, listFlows, setDefaultFlow, updateFlow } from '../../src/approval/flow-store.ts';
import type { FlowStep, Strateji } from '../../src/approval/flow.ts';
import { verifyPassword } from '../../src/auth/password.ts';
import { findSession, openSession } from '../../src/auth/sessions.ts';
import { listAudit } from '../../src/db/audit.ts';
import { p, queryOne, type Db } from '../../src/db/sql.ts';
import { createExpenseService } from '../../src/expenses/forms.ts';
import {
  changeOwnPassword,
  createUser,
  ensureFirstAdmin,
  findLoginUser,
  getUser,
  listUsers,
  resetPassword,
  updateUser,
  type Kullanici,
} from '../../src/users/users.ts';
import { COST_CENTERS, deleteRecord, ORGANIZATIONS } from '../../src/definitions/lists.ts';
import {
  assignDefinitions,
  assignFlow,
  chainOf,
  closeTestDb,
  defaultFlowId,
  makeCostCenter,
  makeFlow,
  makeOrganization,
  makeUser,
  resetDb,
  setFlow,
  testDb,
  TEST_PASSWORD,
} from '../db.ts';

const MIN = 8;
const TTL = 3_600_000;

/** Saves the default flow under its seeded name, as the single flow used to be saved. */
const saveFlow = async (db: Db, actor: Kullanici, adimlar: readonly FlowStep[], currency: string, strateji: Strateji = 'zincir') =>
  updateFlow(db, actor, await defaultFlowId(db), { ad: 'Genel', strateji, adimlar }, currency);
const getFlow = async (db: Db, currency: string) => getFlowById(db, await defaultFlowId(db), currency);

describe('users and the approval flow', () => {
  let db: Db;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
  });

  const fails = (promise: Promise<unknown>, status: number, code: string): Promise<void> =>
    expect(promise).rejects.toMatchObject({ status, code });

  const sessionCount = async (userId: number): Promise<number> =>
    (await queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM dbo.oturumlar WHERE kullanici_id = @k', { k: p.int(userId) }))?.n ?? 0;

  const passwordOf = async (userId: number): Promise<string> =>
    (await queryOne<{ h: string }>(db, 'SELECT sifre_ozeti AS h FROM dbo.kullanicilar WHERE id = @k', { k: p.int(userId) }))?.h ?? '';

  describe('creating users', () => {
    let admin: Kullanici;

    beforeEach(async () => {
      admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    });

    it('stores a lower-case e-mail and makes the user change the password', async () => {
      const user = await createUser(db, admin, { eposta: '  Ayse.Kaya@Firma.COM ', adSoyad: ' Ayşe Kaya ', rol: 'calisan', departman: ' Satış ', sifre: 'GizliSifre1' }, MIN);
      expect(user).toMatchObject({
        eposta: 'ayse.kaya@firma.com',
        adSoyad: 'Ayşe Kaya',
        rol: 'calisan',
        departman: 'Satış',
        aktif: true,
        sifreDegismeli: true,
        sonGiris: null,
        onayAkisiId: null,
        onayAkisi: { id: await defaultFlowId(db), ad: 'Genel', varsayilan: true },
        onaycilik: [],
        organizasyon: null,
        masrafMerkezleri: [],
        olusturma: expect.any(String),
      });
      expect(user).not.toHaveProperty('sifreOzeti');
      const login = await findLoginUser(db, 'AYSE.KAYA@firma.com');
      expect(login?.kullanici.id).toBe(user.id);
      expect(await verifyPassword('GizliSifre1', login?.sifreOzeti ?? '')).toBe(true);
      expect((await listAudit(db, 10))[0]).toMatchObject({
        islem: 'kullanici_olusturuldu',
        kullanici: { id: admin.id, adSoyad: 'Yönetici' },
        ayrinti: expect.stringContaining('ayse.kaya@firma.com'),
      });
    });

    it('refuses a second user with the same e-mail, whatever its case', async () => {
      await createUser(db, admin, { eposta: 'ali@firma.com', adSoyad: 'Ali', rol: 'calisan', sifre: 'GizliSifre1' }, MIN);
      await fails(createUser(db, admin, { eposta: 'ALI@Firma.com', adSoyad: 'Ali 2', rol: 'muhasebe', sifre: 'GizliSifre1' }, MIN), 409, 'eposta_kullaniliyor');
      expect((await listUsers(db)).filter((u) => u.eposta === 'ali@firma.com')).toHaveLength(1);
    });

    it('refuses weak passwords with the field name', async () => {
      for (const sifre of ['Kisa1', 'sadeceharf', '1234567890']) {
        await expect(createUser(db, admin, { eposta: `x${sifre}@firma.com`, adSoyad: 'X', rol: 'calisan', sifre }, MIN)).rejects.toMatchObject({
          status: 400,
          code: 'gecersiz_istek',
          details: { alanlar: { sifre: expect.any(String) } },
        });
      }
      expect(await listUsers(db)).toHaveLength(1);
    });

    it('lists users by name, filtered by text and state, with their place in the flow', async () => {
      const zehra = await makeUser(db, { adSoyad: 'Zehra Yıldız', departman: 'Finans' });
      const can = await makeUser(db, { adSoyad: 'Can Ak', aktif: false });
      await setFlow(
        db,
        [
          { onayciId: admin.id, limit: 1000.49 },
          { onayciId: zehra.id, limit: null },
        ],
        'tek',
      );
      expect((await listUsers(db)).map((u) => u.id)).toEqual([can.id, admin.id, zehra.id]);
      expect((await listUsers(db, { aktif: false })).map((u) => u.id)).toEqual([can.id]);
      expect((await listUsers(db, { q: 'finans' })).map((u) => u.id)).toEqual([zehra.id]);
      expect((await listUsers(db, { q: '%' })).map((u) => u.id)).toEqual([]);
      const genel = { id: await defaultFlowId(db), ad: 'Genel', strateji: 'tek' };
      // Each approver's limit and the amounts that reach them, to the cent.
      const zehraPlace = { akis: genel, sira: 2, limit: null, altLimit: 1000.5, ustLimit: null };
      const adminPlace = { akis: genel, sira: 1, limit: 1000.49, altLimit: 0, ustLimit: 1000.49 };
      expect((await getUser(db, zehra.id))?.onaycilik).toEqual([zehraPlace]);
      expect((await listUsers(db)).find((u) => u.id === zehra.id)?.onaycilik).toEqual([zehraPlace]);
      expect((await getUser(db, admin.id))?.onaycilik).toEqual([adminPlace]);
      expect((await listUsers(db)).find((u) => u.id === admin.id)?.onaycilik).toEqual([adminPlace]);
      expect((await getUser(db, can.id))?.onaycilik).toEqual([]);
      expect(await getUser(db, 999_999)).toBeNull();
    });
  });

  describe('changing users', () => {
    let admin: Kullanici;
    let accounting: Kullanici;

    beforeEach(async () => {
      admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
      accounting = await makeUser(db, { rol: 'muhasebe' });
    });

    it('updates fields and writes what changed to the audit log', async () => {
      const user = await makeUser(db, { adSoyad: 'Eski Ad', eposta: 'eski@firma.com' });
      const after = await updateUser(db, admin, user.id, { adSoyad: 'Yeni Ad', eposta: 'Yeni@Firma.com', rol: 'muhasebe', departman: '' });
      expect(after).toMatchObject({ adSoyad: 'Yeni Ad', eposta: 'yeni@firma.com', rol: 'muhasebe', departman: null });
      expect((await listAudit(db, 1))[0]).toMatchObject({
        islem: 'kullanici_guncellendi',
        kullanici: { id: admin.id },
        ayrinti: expect.stringMatching(/Yeni Ad: .*e-posta eski@firma.com → yeni@firma.com.*rol calisan → muhasebe/),
      });
      await fails(updateUser(db, admin, 999_999, { adSoyad: 'Kimse' }), 404, 'bulunamadi');
    });

    it('refuses an e-mail another user has', async () => {
      await makeUser(db, { eposta: 'dolu@firma.com' });
      const user = await makeUser(db);
      await fails(updateUser(db, admin, user.id, { eposta: 'DOLU@firma.com' }), 409, 'eposta_kullaniliyor');
    });

    it('keeps at least one active administrator', async () => {
      // The only administrator may neither lose the role nor be deactivated (here by someone else).
      await fails(updateUser(db, admin, admin.id, { rol: 'calisan' }), 409, 'son_yonetici');
      await fails(updateUser(db, accounting, admin.id, { aktif: false }), 409, 'son_yonetici');
      // An inactive administrator does not count.
      const sleeping = await makeUser(db, { rol: 'yonetici', aktif: false });
      await fails(updateUser(db, admin, admin.id, { rol: 'muhasebe' }), 409, 'son_yonetici');
      expect((await getUser(db, admin.id))?.rol).toBe('yonetici');

      await updateUser(db, admin, sleeping.id, { aktif: true });
      expect((await updateUser(db, admin, admin.id, { rol: 'muhasebe' })).rol).toBe('muhasebe');
      await fails(updateUser(db, admin, sleeping.id, { rol: 'calisan' }), 409, 'son_yonetici');
    });

    it('keeps one administrator when two demote each other at the same time', async () => {
      const second = await makeUser(db, { rol: 'yonetici' });
      const results = await Promise.allSettled([updateUser(db, admin, second.id, { rol: 'calisan' }), updateUser(db, second, admin.id, { aktif: false })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ status: 409, code: 'son_yonetici' });
      const admins = (await listUsers(db)).filter((u) => u.rol === 'yonetici' && u.aktif);
      expect(admins).toHaveLength(1);
    });

    it('creates only one of two simultaneous users with the same e-mail', async () => {
      const input = { eposta: 'ayni@firma.com', adSoyad: 'Aynı', rol: 'calisan' as const, sifre: 'GizliSifre1' };
      const results = await Promise.allSettled([createUser(db, admin, input, MIN), createUser(db, admin, { ...input, eposta: 'AYNI@firma.com' }, MIN)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'eposta_kullaniliyor' } });
    });

    it('does not let an administrator deactivate their own account', async () => {
      await makeUser(db, { rol: 'yonetici' });
      await fails(updateUser(db, admin, admin.id, { aktif: false }), 409, 'kendi_hesabi');
      expect((await getUser(db, admin.id))?.aktif).toBe(true);
    });

    it('does not deactivate a user who is in the approval flow', async () => {
      const approver = await makeUser(db, { adSoyad: 'Akıştaki Kişi' });
      await setFlow(db, chainOf(admin.id, approver.id));
      const err = await updateUser(db, admin, approver.id, { aktif: false }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: 'onay_akisinda', message: expect.stringContaining('Genel (2. sıra)') });
      // Other changes are fine.
      expect((await updateUser(db, admin, approver.id, { departman: 'Finans' })).departman).toBe('Finans');
    });

    it('does not deactivate a user with undecided approvals until they are handed over', async () => {
      const approver = await makeUser(db);
      const later = await makeUser(db);
      const sender = await makeUser(db);
      await setFlow(db, chainOf(admin.id, approver.id, later.id));
      const expenses = createExpenseService(db, { baseCurrency: 'TRY' });
      const f = await expenses.create(sender, { baslik: 'Yemek', kategoriId: 1, masrafTarihi: '2025-06-15', tutar: 100 }, true);
      await setFlow(db, chainOf(admin.id));

      // `later` only waits for their turn ('sirada'); that counts as well.
      await fails(updateUser(db, admin, approver.id, { aktif: false }), 409, 'bekleyen_onay_var');
      await fails(updateUser(db, admin, later.id, { aktif: false }), 409, 'bekleyen_onay_var');

      const stepOf = (id: number): number => f.onaylar.find((o) => o.onayci.id === id)?.id ?? 0;
      await expenses.reassign(f.id, admin, stepOf(approver.id), accounting.id);
      expect((await updateUser(db, admin, approver.id, { aktif: false })).aktif).toBe(false);

      // A withdrawn form leaves nothing to decide.
      await expenses.withdraw(f.id, sender);
      expect((await updateUser(db, admin, later.id, { aktif: false })).aktif).toBe(false);
    });

    it('ends the sessions of a deactivated user', async () => {
      const user = await makeUser(db);
      const { token } = await openSession(db, user.id, 'mobil', TTL);
      await openSession(db, user.id, 'panel', TTL);
      await updateUser(db, admin, user.id, { aktif: false });
      expect(await sessionCount(user.id)).toBe(0);
      expect(await findSession(db, token, TTL)).toBeNull();
      expect((await listAudit(db, 1))[0]?.ayrinti).toContain('pasifleştirildi');
    });

    it('resets a password: the user must change it and every session ends', async () => {
      const user = await makeUser(db, { adSoyad: 'Unutkan' });
      await openSession(db, user.id, 'mobil', TTL);
      await openSession(db, user.id, 'panel', TTL);
      await resetPassword(db, admin, user.id, 'YeniSifre2026', MIN);
      expect(await getUser(db, user.id)).toMatchObject({ sifreDegismeli: true });
      expect(await sessionCount(user.id)).toBe(0);
      expect(await verifyPassword('YeniSifre2026', await passwordOf(user.id))).toBe(true);
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'sifre_sifirlandi', ayrinti: 'Unutkan', kullanici: { id: admin.id } });

      await expect(resetPassword(db, admin, user.id, 'kisa', MIN)).rejects.toMatchObject({
        status: 400,
        code: 'gecersiz_istek',
        details: { alanlar: { yeniSifre: expect.any(String) } },
      });
      await fails(resetPassword(db, admin, 999_999, 'YeniSifre2026', MIN), 404, 'bulunamadi');
    });

    it('changes the own password, keeping only the current session', async () => {
      const user = await makeUser(db, { sifreDegismeli: true });
      const current = await openSession(db, user.id, 'mobil', TTL);
      const other = await openSession(db, user.id, 'panel', TTL);

      await expect(changeOwnPassword(db, user.id, 'Yanlis1234', 'YeniSifre2026', current.tokenOzeti, MIN)).rejects.toMatchObject({
        status: 400,
        code: 'hatali_sifre',
        details: { alanlar: { mevcutSifre: expect.any(String) } },
      });
      await fails(changeOwnPassword(db, user.id, TEST_PASSWORD, TEST_PASSWORD, current.tokenOzeti, MIN), 400, 'gecersiz_istek');
      await fails(changeOwnPassword(db, user.id, TEST_PASSWORD, 'kisa', current.tokenOzeti, MIN), 400, 'gecersiz_istek');
      expect(await sessionCount(user.id)).toBe(2);

      await changeOwnPassword(db, user.id, TEST_PASSWORD, 'YeniSifre2026', current.tokenOzeti, MIN);
      expect((await getUser(db, user.id))?.sifreDegismeli).toBe(false);
      expect(await findSession(db, current.token, TTL)).not.toBeNull();
      expect(await findSession(db, other.token, TTL)).toBeNull();
      expect(await verifyPassword('YeniSifre2026', await passwordOf(user.id))).toBe(true);
      expect(await verifyPassword(TEST_PASSWORD, await passwordOf(user.id))).toBe(false);
    });
  });

  describe('first administrator', () => {
    it('creates the first administrator as the only approver, once', async () => {
      const admin = { eposta: 'ilk@firma.com', adSoyad: 'İlk Yönetici', sifre: 'IlkSifre2026' };
      expect(await ensureFirstAdmin(db, null)).toBe('ayar_yok');
      expect(await ensureFirstAdmin(db, admin)).toBe('olusturuldu');
      const [user] = await listUsers(db);
      expect(user).toMatchObject({
        eposta: 'ilk@firma.com',
        rol: 'yonetici',
        aktif: true,
        onaycilik: [{ akis: { id: await defaultFlowId(db), ad: 'Genel', strateji: 'zincir' }, sira: 1, limit: null, altLimit: 0, ustLimit: null }],
      });
      const flow = await getFlow(db, 'TRY');
      // The first flow is a chain that starts with the administrator, without a limit.
      expect(flow).toMatchObject({ strateji: 'zincir', guncelleyen: { id: user?.id }, adimlar: [{ sira: 1, onayci: { id: user?.id }, limit: null }] });
      expect(await ensureFirstAdmin(db, { ...admin, eposta: 'ikinci@firma.com' })).toBe('kullanici_var');
      expect(await listUsers(db)).toHaveLength(1);
    });
  });

  describe('saving the approval flow', () => {
    let admin: Kullanici;
    let a: Kullanici;
    let b: Kullanici;

    beforeEach(async () => {
      admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
      a = await makeUser(db, { adSoyad: 'Ayşe', eposta: 'ayse@firma.com', departman: 'Satış' });
      b = await makeUser(db, { adSoyad: 'Mehmet' });
      await setFlow(db, chainOf(admin.id));
    });

    const invalid = async (promise: Promise<unknown>): Promise<string[]> => {
      const err = (await promise.then(
        () => null,
        (e: unknown) => e,
      )) as { status: number; code: string; message: string; details?: { sorunlar?: string[] } } | null;
      expect(err).toMatchObject({ status: 400, code: 'gecersiz_akis' });
      expect(err?.message).toBe(err?.details?.sorunlar?.[0]);
      return err?.details?.sorunlar ?? [];
    };

    /** The flow must be the one set in beforeEach: a refused save changes nothing. */
    const unchanged = async (): Promise<void> => {
      expect((await getFlow(db, 'TRY')).adimlar.map((s) => s.onayci.id)).toEqual([admin.id]);
    };

    it('replaces the flow in the given order with its strategy and writes the audit log', async () => {
      const steps = [
        { onayciId: a.id, limit: 5000 },
        { onayciId: b.id, limit: 50000 },
        { onayciId: admin.id, limit: null },
      ];
      const flow = await saveFlow(db, admin, steps, 'TRY', 'tek');
      expect(flow).toEqual({
        id: await defaultFlowId(db),
        ad: 'Genel',
        varsayilan: true,
        strateji: 'tek',
        paraBirimi: 'TRY',
        guncelleme: expect.any(String),
        guncelleyen: { id: admin.id, adSoyad: 'Yönetici' },
        kullaniciSayisi: 3,
        adimlar: [
          { sira: 1, onayci: { id: a.id, adSoyad: 'Ayşe', eposta: 'ayse@firma.com', departman: 'Satış' }, limit: 5000 },
          { sira: 2, onayci: { id: b.id, adSoyad: 'Mehmet', eposta: b.eposta, departman: null }, limit: 50000 },
          { sira: 3, onayci: { id: admin.id, adSoyad: 'Yönetici', eposta: admin.eposta, departman: null }, limit: null },
        ],
      });
      expect(await getFlow(db, 'TRY')).toEqual(flow);
      expect((await listAudit(db, 1))[0]).toMatchObject({
        islem: 'onay_akisi_guncellendi',
        kullanici: { id: admin.id },
        ayrinti: "Genel: tek onaycı; 1) Ayşe: 5.000,00 TRY'ye kadar; 2) Mehmet: 50.000,00 TRY'ye kadar; 3) Yönetici: sınırsız",
      });
      // A single approver gets the amounts from just above the previous limit up to their own.
      expect((await getUser(db, b.id))?.onaycilik).toEqual([{ akis: { id: flow.id, ad: 'Genel', strateji: 'tek' }, sira: 2, limit: 50000, altLimit: 5000.01, ustLimit: 50000 }]);

      // The same approvers as a chain: larger amounts pass through them too.
      const chain = await saveFlow(db, admin, steps, 'TRY', 'zincir');
      expect(chain).toMatchObject({ strateji: 'zincir', adimlar: [{ limit: 5000 }, { limit: 50000 }, { limit: null }] });
      expect((await listAudit(db, 1))[0]?.ayrinti).toBe("Genel: zincirleme onay; 1) Ayşe: 5.000,00 TRY'ye kadar; 2) Mehmet: 50.000,00 TRY'ye kadar; 3) Yönetici: sınırsız");
      expect((await getUser(db, b.id))?.onaycilik).toEqual([{ akis: { id: flow.id, ad: 'Genel', strateji: 'zincir' }, sira: 2, limit: 50000, altLimit: 5000.01, ustLimit: null }]);
    });

    it('refuses an empty flow', async () => {
      expect(await invalid(saveFlow(db, admin, [], 'TRY'))).toEqual(['Onay akışında en az bir onaycı olmalıdır.']);
      await unchanged();
    });

    it('requires a limit on every approver but the last, and none on the last', async () => {
      const limited = await invalid(
        saveFlow(
          db,
          admin,
          [
            { onayciId: a.id, limit: 1000 },
            { onayciId: b.id, limit: 10000 },
          ],
          'TRY',
        ),
      );
      expect(limited).toEqual(['Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.']);
      const open = await invalid(
        saveFlow(
          db,
          admin,
          [
            { onayciId: a.id, limit: null },
            { onayciId: b.id, limit: null },
          ],
          'TRY',
          'tek',
        ),
      );
      expect(open).toEqual(['1. onaycı: onay limiti girilmelidir. Yalnızca son onaycının limiti sınırsızdır.']);
      await unchanged();
    });

    it('refuses repeated approvers, limits that do not rise and limits that are not above zero', async () => {
      const sorunlar = await invalid(
        saveFlow(
          db,
          admin,
          [
            { onayciId: a.id, limit: 5000 },
            { onayciId: a.id, limit: 5000 },
            { onayciId: b.id, limit: null },
          ],
          'TRY',
        ),
      );
      expect(sorunlar).toEqual(['2. onaycı: aynı kullanıcı akışta birden fazla kez yer alamaz.', '2. onaycının limiti, 1. onaycınınkinden (5.000,00 TRY) büyük olmalıdır.']);
      const zero = await invalid(
        saveFlow(
          db,
          admin,
          [
            { onayciId: a.id, limit: 0 },
            { onayciId: b.id, limit: null },
          ],
          'EUR',
        ),
      );
      expect(zero).toEqual(["1. onaycı: onay limiti 0'dan büyük ve en fazla 90.000.000.000.000,00 EUR olmalıdır."]);
      await unchanged();
    });

    it('refuses inactive and unknown users', async () => {
      const gone = await makeUser(db, { adSoyad: 'Pasif Kişi', aktif: false });
      const sorunlar = await invalid(
        saveFlow(
          db,
          admin,
          chainOf(a.id, gone.id, 999_999),
          'TRY',
        ),
      );
      expect(sorunlar).toEqual(['2. onaycı: Pasif Kişi pasif bir kullanıcı.', '3. onaycı: kullanıcı bulunamadı.']);
      await unchanged();
      expect((await listAudit(db, 10)).filter((e) => e.islem === 'onay_akisi_guncellendi')).toEqual([]);
    });

    it('never leaves an inactive user in the flow when adding and deactivating race', async () => {
      const results = await Promise.allSettled([
        saveFlow(db, admin, chainOf(a.id, admin.id), 'TRY'),
        updateUser(db, admin, a.id, { aktif: false }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const flow = await getFlow(db, 'TRY');
      const user = await getUser(db, a.id);
      if (user?.aktif === false) expect(flow.adimlar.map((s) => s.onayci.id)).toEqual([admin.id]);
      else expect(flow.adimlar.map((s) => s.onayci.id)).toEqual([a.id, admin.id]);
    });

    it('lets a user leave the flow and then be deactivated', async () => {
      await saveFlow(db, admin, chainOf(a.id, admin.id), 'TRY');
      await fails(updateUser(db, admin, a.id, { aktif: false }), 409, 'onay_akisinda');
      await saveFlow(db, admin, chainOf(admin.id), 'TRY');
      expect((await updateUser(db, admin, a.id, { aktif: false })).aktif).toBe(false);
      await expect(saveFlow(db, admin, chainOf(a.id), 'TRY')).rejects.toMatchObject({ code: 'gecersiz_akis' });
    });
  });

  describe('several approval flows', () => {
    let admin: Kullanici;
    let a: Kullanici;
    let b: Kullanici;
    let genel: number;

    beforeEach(async () => {
      admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
      a = await makeUser(db, { adSoyad: 'Ayşe' });
      b = await makeUser(db, { adSoyad: 'Mehmet' });
      genel = await defaultFlowId(db);
      await setFlow(db, chainOf(admin.id));
    });

    it('creates a flow, checks its rules and lists the default first', async () => {
      const satis = await createFlow(
        db,
        admin,
        {
          ad: '  Satış ',
          strateji: 'tek',
          adimlar: [
            { onayciId: a.id, limit: 5000 },
            { onayciId: b.id, limit: null },
          ],
        },
        'TRY',
      );
      expect(satis).toMatchObject({
        ad: 'Satış',
        varsayilan: false,
        strateji: 'tek',
        guncelleyen: { id: admin.id },
        kullaniciSayisi: 0,
        adimlar: [
          { sira: 1, onayci: { id: a.id }, limit: 5000 },
          { sira: 2, onayci: { id: b.id }, limit: null },
        ],
      });
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'onay_akisi_olusturuldu', ayrinti: "Satış: tek onaycı; 1) Ayşe: 5.000,00 TRY'ye kadar; 2) Mehmet: sınırsız" });
      expect(await createFlow(db, admin, { ad: 'Ar-Ge', strateji: 'zincir', adimlar: chainOf(b.id) }, 'TRY')).toMatchObject({ strateji: 'zincir', adimlar: [{ limit: null }] });
      expect((await listFlows(db, 'TRY')).map((f) => [f.ad, f.varsayilan, f.kullaniciSayisi])).toEqual([
        ['Genel', true, 3],
        ['Ar-Ge', false, 0],
        ['Satış', false, 0],
      ]);
      // Names are unique whatever their case; every flow has the same rules as before.
      await fails(createFlow(db, admin, { ad: 'SATIŞ', strateji: 'zincir', adimlar: chainOf(a.id) }, 'TRY'), 409, 'akis_adi_kullaniliyor');
      await fails(createFlow(db, admin, { ad: 'Boş', strateji: 'zincir', adimlar: [] }, 'TRY'), 400, 'gecersiz_akis');
      await fails(createFlow(db, admin, { ad: 'Sınırlı', strateji: 'tek', adimlar: [{ onayciId: a.id, limit: 100 }] }, 'TRY'), 400, 'gecersiz_akis');
      expect(await listFlows(db, 'TRY')).toHaveLength(3);
    });

    it('lets one user approve in several flows, each with its own limit and strategy', async () => {
      const satis = await makeFlow(
        db,
        'Satış',
        [
          { onayciId: a.id, limit: 1000 },
          { onayciId: admin.id, limit: null },
        ],
        'tek',
      );
      await setFlow(db, [
        { onayciId: admin.id, limit: 5000 },
        { onayciId: a.id, limit: null },
      ]);
      expect((await getUser(db, a.id))?.onaycilik).toEqual([
        { akis: { id: genel, ad: 'Genel', strateji: 'zincir' }, sira: 2, limit: null, altLimit: 5000.01, ustLimit: null },
        { akis: { id: satis, ad: 'Satış', strateji: 'tek' }, sira: 1, limit: 1000, altLimit: 0, ustLimit: 1000 },
      ]);
      const err = await updateUser(db, admin, a.id, { aktif: false }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: 'onay_akisinda', message: 'Ayşe onay akışında onaycı: Genel (2. sıra), Satış (1. sıra). Önce bu akışlardan çıkarın.' });
    });

    it('renames and replaces a flow, and refuses a taken name or an unknown flow', async () => {
      const satis = await makeFlow(db, 'Satış', chainOf(a.id));
      await makeFlow(db, 'Yönetim', chainOf(admin.id));
      const after = await updateFlow(db, admin, satis, { ad: 'Satış ve Pazarlama', strateji: 'tek', adimlar: chainOf(b.id) }, 'TRY');
      expect(after).toMatchObject({ id: satis, ad: 'Satış ve Pazarlama', strateji: 'tek', adimlar: [{ sira: 1, onayci: { id: b.id }, limit: null }] });
      expect((await listAudit(db, 1))[0]?.ayrinti).toContain('Satış → Satış ve Pazarlama: tek onaycı');
      await fails(updateFlow(db, admin, satis, { ad: 'yönetim', strateji: 'zincir', adimlar: chainOf(b.id) }, 'TRY'), 409, 'akis_adi_kullaniliyor');
      await fails(updateFlow(db, admin, 999_999, { ad: 'Yok', strateji: 'zincir', adimlar: chainOf(b.id) }, 'TRY'), 404, 'bulunamadi');
      await fails(getFlowById(db, 999_999, 'TRY'), 404, 'bulunamadi');
      expect((await getFlowById(db, satis, 'TRY')).ad).toBe('Satış ve Pazarlama');
    });

    it('assigns users to a flow; unassigned users follow the default', async () => {
      const satis = await makeFlow(db, 'Satış', chainOf(a.id));
      const created = await createUser(db, admin, { eposta: 'yeni@firma.com', adSoyad: 'Yeni', rol: 'calisan', sifre: 'GizliSifre1', onayAkisiId: satis }, MIN);
      expect(created).toMatchObject({ onayAkisiId: satis, onayAkisi: { id: satis, ad: 'Satış', varsayilan: false } });
      expect((await listAudit(db, 1))[0]?.ayrinti).toContain('onay akışı: Satış');

      const moved = await updateUser(db, admin, b.id, { onayAkisiId: satis });
      expect(moved).toMatchObject({ onayAkisiId: satis, onayAkisi: { id: satis, ad: 'Satış' } });
      expect((await listAudit(db, 1))[0]?.ayrinti).toBe('Mehmet: onay akışı varsayılan (Genel) → Satış');
      expect((await getFlowById(db, satis, 'TRY')).kullaniciSayisi).toBe(2);

      const back = await updateUser(db, admin, b.id, { onayAkisiId: null });
      expect(back).toMatchObject({ onayAkisiId: null, onayAkisi: { id: genel, ad: 'Genel', varsayilan: true } });

      for (const run of [
        () => updateUser(db, admin, b.id, { onayAkisiId: 999_999 }),
        () => createUser(db, admin, { eposta: 'baska@firma.com', adSoyad: 'Başka', rol: 'calisan', sifre: 'GizliSifre1', onayAkisiId: 999_999 }, MIN),
      ]) {
        await expect(run()).rejects.toMatchObject({ status: 400, code: 'gecersiz_istek', details: { alanlar: { onayAkisiId: 'Onay akışı bulunamadı.' } } });
      }
      expect((await getUser(db, b.id))?.onayAkisiId).toBeNull();
      expect((await listUsers(db)).some((u) => u.eposta === 'baska@firma.com')).toBe(false);
    });

    it('switches the default: unassigned users follow it, assigned users stay', async () => {
      const satis = await makeFlow(db, 'Satış', chainOf(a.id));
      const yonetim = await makeFlow(db, 'Yönetim', chainOf(admin.id));
      await assignFlow(db, b.id, yonetim);
      const now = await setDefaultFlow(db, admin, satis, 'TRY');
      expect(now).toMatchObject({ id: satis, varsayilan: true, kullaniciSayisi: 2 });
      expect((await getFlowById(db, genel, 'TRY')).varsayilan).toBe(false);
      expect((await getUser(db, a.id))?.onayAkisi).toEqual({ id: satis, ad: 'Satış', varsayilan: true });
      expect((await getUser(db, b.id))?.onayAkisi).toEqual({ id: yonetim, ad: 'Yönetim', varsayilan: false });
      expect((await listAudit(db, 1))[0]).toMatchObject({ islem: 'varsayilan_akis_degisti', ayrinti: 'Genel → Satış' });
      // Making the default the default again changes nothing.
      expect((await setDefaultFlow(db, admin, satis, 'TRY')).varsayilan).toBe(true);
      expect((await listAudit(db, 1))[0]?.islem).toBe('varsayilan_akis_degisti');
      await fails(setDefaultFlow(db, admin, 999_999, 'TRY'), 404, 'bulunamadi');
    });

    it('keeps exactly one default when two flows are made default at once', async () => {
      const x = await makeFlow(db, 'X', chainOf(a.id));
      const y = await makeFlow(db, 'Y', chainOf(b.id));
      await Promise.all([setDefaultFlow(db, admin, x, 'TRY'), setDefaultFlow(db, admin, y, 'TRY')]);
      expect((await listFlows(db, 'TRY')).filter((f) => f.varsayilan)).toHaveLength(1);
    });

    it('deletes a flow: its users go back to the default; the default cannot be deleted', async () => {
      const satis = await makeFlow(db, 'Satış', chainOf(a.id));
      await assignFlow(db, b.id, satis);
      await fails(deleteFlow(db, admin, genel), 409, 'varsayilan_akis');
      await deleteFlow(db, admin, satis);
      expect((await listFlows(db, 'TRY')).map((f) => f.id)).toEqual([genel]);
      expect(await getUser(db, b.id)).toMatchObject({ onayAkisiId: null, onayAkisi: { id: genel } });
      // Leaving its last flow, the approver can now be deactivated.
      expect((await getUser(db, a.id))?.onaycilik).toEqual([]);
      expect((await updateUser(db, admin, a.id, { aktif: false })).aktif).toBe(false);
      expect((await listAudit(db, 10)).find((e) => e.islem === 'onay_akisi_silindi')?.ayrinti).toBe('Satış (1 kullanıcı varsayılan akışa geçti)');
      await fails(deleteFlow(db, admin, satis), 404, 'bulunamadi');
    });
  });
  describe('organisation and cost centres', () => {
    let admin: Kullanici;

    beforeEach(async () => {
      admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    });

    const centreIds = (u: Kullanici | null): number[] => (u?.masrafMerkezleri ?? []).map((m) => m.id);

    it('creates a user with them and lists the cost centres by code', async () => {
      const org = await makeOrganization(db, '1000', 'Şenpiliç');
      const z = await makeCostCenter(db, 'Z-9', 'Son');
      const a = await makeCostCenter(db, 'A-1');
      const user = await createUser(db, admin, { eposta: 'ayse@firma.com', adSoyad: 'Ayşe', rol: 'calisan', sifre: 'GizliSifre1', organizasyonId: org, masrafMerkeziIdler: [z, a] }, MIN);
      expect(user.organizasyon).toEqual({ id: org, kod: '1000', ad: 'Şenpiliç', aktif: true });
      expect(user.masrafMerkezleri).toEqual([
        { id: a, kod: 'A-1', aciklama: null, gosterim: 'A-1', aktif: true },
        { id: z, kod: 'Z-9', aciklama: 'Son', gosterim: 'Z-9 – Son', aktif: true },
      ]);
      expect((await listUsers(db)).find((u) => u.id === user.id)).toEqual(user);
      expect((await findLoginUser(db, 'ayse@firma.com'))?.kullanici).toEqual(user);
    });

    it('replaces the cost centres only when given, and leaves the organisation when not given', async () => {
      const user = await makeUser(db);
      const org = await makeOrganization(db, '1000');
      const [a, b, c] = [await makeCostCenter(db, 'A'), await makeCostCenter(db, 'B'), await makeCostCenter(db, 'C')];
      await assignDefinitions(db, user.id, org, [a, b]);
      expect(centreIds(await updateUser(db, admin, user.id, { departman: 'Satış' }))).toEqual([a, b]);
      const changed = await updateUser(db, admin, user.id, { masrafMerkeziIdler: [c, b] });
      expect(changed.organizasyon?.id).toBe(org);
      expect(centreIds(changed)).toEqual([b, c]);
      expect(centreIds(await updateUser(db, admin, user.id, { masrafMerkeziIdler: [] }))).toEqual([]);
      expect((await updateUser(db, admin, user.id, { organizasyonId: null })).organizasyon).toBeNull();
    });

    it('refuses records that do not exist and inactive ones the user does not have yet', async () => {
      const user = await makeUser(db);
      const passiveOrg = await makeOrganization(db, '9000', 'Kapalı', false);
      const passive = await makeCostCenter(db, 'PASIF', null, false);
      const active = await makeCostCenter(db, 'AKTIF');
      await expect(updateUser(db, admin, user.id, { organizasyonId: passiveOrg })).rejects.toMatchObject({
        status: 400,
        code: 'gecersiz_istek',
        details: { alanlar: { organizasyonId: 'Organizasyon pasif; kullanıcıya tanımlanamaz.' } },
      });
      await expect(updateUser(db, admin, user.id, { organizasyonId: 999_999, masrafMerkeziIdler: [active, 999_999, passive] })).rejects.toMatchObject({
        details: {
          alanlar: {
            organizasyonId: 'Organizasyon bulunamadı.',
            'masrafMerkeziIdler.1': 'Masraf merkezi bulunamadı.',
            'masrafMerkeziIdler.2': 'Masraf merkezi pasif; kullanıcıya tanımlanamaz.',
          },
        },
      });
      expect(centreIds(await getUser(db, user.id))).toEqual([]);
      // Already assigned, then deactivated: may stay.
      await assignDefinitions(db, user.id, passiveOrg, [passive]);
      const kept = await updateUser(db, admin, user.id, { organizasyonId: passiveOrg, masrafMerkeziIdler: [passive, active] });
      expect(kept.organizasyon).toMatchObject({ id: passiveOrg, aktif: false });
      expect(centreIds(kept)).toEqual([active, passive]);
    });

    it('keeps an assigned organisation or cost centre from being deleted', async () => {
      const user = await makeUser(db);
      const org = await makeOrganization(db, '1000');
      const centre = await makeCostCenter(db, 'MM');
      await updateUser(db, admin, user.id, { organizasyonId: org, masrafMerkeziIdler: [centre] });
      await fails(deleteRecord(db, admin, ORGANIZATIONS, org), 409, 'kullaniliyor');
      await fails(deleteRecord(db, admin, COST_CENTERS, centre), 409, 'kullaniliyor');
      await updateUser(db, admin, user.id, { organizasyonId: null, masrafMerkeziIdler: [] });
      await deleteRecord(db, admin, ORGANIZATIONS, org);
      await deleteRecord(db, admin, COST_CENTERS, centre);
      expect(await getUser(db, user.id)).toMatchObject({ organizasyon: null, masrafMerkezleri: [] });
    });

    it('writes the changes to the audit log', async () => {
      const user = await makeUser(db, { adSoyad: 'Mehmet' });
      const [o1, o2] = [await makeOrganization(db, '1000'), await makeOrganization(db, '2000')];
      const [a, b] = [await makeCostCenter(db, 'A'), await makeCostCenter(db, 'B')];
      await updateUser(db, admin, user.id, { organizasyonId: o1, masrafMerkeziIdler: [a] });
      await updateUser(db, admin, user.id, { organizasyonId: o2, masrafMerkeziIdler: [b] });
      expect((await listAudit(db, 2)).map((e) => e.ayrinti)).toEqual([
        'Mehmet: organizasyon 1000 → 2000, masraf merkezleri +B -A',
        'Mehmet: organizasyon - → 1000, masraf merkezleri +A',
      ]);
    });
  });
});
