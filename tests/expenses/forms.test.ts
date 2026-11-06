// The expense form service against the test database: routing, the form life cycle, permissions,
// invoices, races and the read models (inbox, summary, preview, export). See docs/onay-sistemi.md.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute, p, query, type Db } from '../../src/db/sql.ts';
import { createExpenseService, type ExpenseService, type FormInput, type MasrafDetay } from '../../src/expenses/forms.ts';
import type { Izinler } from '../../src/expenses/rules.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { assignFlow, chainOf, closeTestDb, defaultFlowId, makeFlow, makeInvoice, makeUser, resetDb, setFlow, testDb } from '../db.ts';

const PAST = '2025-06-15';
const form = (over: Partial<FormInput> = {}): FormInput => ({ baslik: 'Müşteri yemeği', kategoriId: 1, masrafTarihi: PAST, tutar: 100, ...over });

/** Approvers of the current round, in order, with their state. */
const chain = (d: MasrafDetay): Array<{ id: number; durum: string }> => d.onaylar.map((o) => ({ id: o.onayci.id, durum: o.durum }));
const events = (d: MasrafDetay): string[] => d.gecmis.map((g) => g.islem);

const NONE: Izinler = { duzenle: false, gonder: false, geriCek: false, iptal: false, onayla: false, reddet: false, odendi: false, devret: false };
const allow = (...keys: Array<keyof Izinler>): Izinler => ({ ...NONE, ...Object.fromEntries(keys.map((k) => [k, true])) });

describe('expense service', () => {
  let db: Db;
  let svc: ExpenseService;

  beforeAll(async () => {
    db = await testDb();
    svc = createExpenseService(db, { baseCurrency: 'TRY' });
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
  });

  const fails = (promise: Promise<unknown>, status: number, code: string): Promise<void> =>
    expect(promise).rejects.toMatchObject({ status, code });

  /** Every approval row of the form, all rounds. */
  const rows = (formId: number) =>
    query<{ tur: number; sira: number; onayci_id: number; durum: string }>(
      db,
      'SELECT tur, sira, onayci_id, durum FROM dbo.form_onaylari WHERE form_id = @f ORDER BY tur, sira',
      { f: p.int(formId) },
    );

  describe('routing', () => {
    it('chain: sends a form to every approver up to the one whose limit covers the approval amount, in flow order', async () => {
      const ayse = await makeUser(db, { adSoyad: 'Ayşe' });
      const mehmet = await makeUser(db, { adSoyad: 'Mehmet' });
      const zeynep = await makeUser(db, { adSoyad: 'Zeynep' });
      const sender = await makeUser(db);
      await setFlow(db, [
        { onayciId: ayse.id, limit: 5000 },
        { onayciId: mehmet.id, limit: 50000 },
        { onayciId: zeynep.id, limit: null },
      ]);

      const small = await svc.create(sender, form({ tutar: 3000 }), true);
      expect(small).toMatchObject({ durum: 'onayda', tur: 1, onayTutari: 3000, siradakiOnayci: { id: ayse.id, adSoyad: 'Ayşe' } });
      expect(chain(small)).toEqual([{ id: ayse.id, durum: 'bekliyor' }]);

      const mid = await svc.create(sender, form({ tutar: 20000 }), true);
      expect(chain(mid)).toEqual([
        { id: ayse.id, durum: 'bekliyor' },
        { id: mehmet.id, durum: 'sirada' },
      ]);

      const big = await svc.create(sender, form({ tutar: 80000 }), true);
      expect(chain(big)).toEqual([
        { id: ayse.id, durum: 'bekliyor' },
        { id: mehmet.id, durum: 'sirada' },
        { id: zeynep.id, durum: 'sirada' },
      ]);
      expect(big.onaylar.map((o) => o.sira)).toEqual([1, 2, 3]);
      expect(big.onaylar[2]).toMatchObject({ tur: 1, altLimit: 50000.01, ustLimit: null, yedek: false, aciklama: null, kararTarihi: null });
      expect(events(big)).toEqual(['olusturuldu', 'gonderildi']);
      expect(big.gecmis[1]?.aciklama).toContain('Ayşe → Mehmet → Zeynep');
    });

    it('walks a chain one approver at a time', async () => {
      const ayse = await makeUser(db);
      const mehmet = await makeUser(db);
      const sender = await makeUser(db);
      await setFlow(db, [
        { onayciId: ayse.id, limit: 5000 },
        { onayciId: mehmet.id, limit: null },
      ]);
      const f = await svc.create(sender, form({ tutar: 20000 }), true);

      await fails(svc.approve(f.id, mehmet, null), 409, 'onay_beklemiyor');

      const first = await svc.approve(f.id, ayse, 'Uygun');
      expect(first.durum).toBe('onayda');
      expect(chain(first)).toEqual([
        { id: ayse.id, durum: 'onaylandi' },
        { id: mehmet.id, durum: 'bekliyor' },
      ]);
      expect(first.onaylar[0]).toMatchObject({ aciklama: 'Uygun', kararTarihi: expect.any(String) });
      expect(first.siradakiOnayci?.id).toBe(mehmet.id);
      expect(first.sonuclanma).toBeNull();

      const done = await svc.approve(f.id, mehmet, null);
      expect(done).toMatchObject({ durum: 'onaylandi', siradakiOnayci: null, sonuclanma: expect.any(String) });
      expect(chain(done)).toEqual([
        { id: ayse.id, durum: 'onaylandi' },
        { id: mehmet.id, durum: 'onaylandi' },
      ]);
      expect(events(done)).toEqual(['olusturuldu', 'gonderildi', 'onaylandi', 'onaylandi', 'tamamlandi']);
    });

    it("single approver ('tek'): sends to the approver whose limit covers the amount, down to the cent", async () => {
      const low = await makeUser(db);
      const mid = await makeUser(db);
      const high = await makeUser(db);
      const sender = await makeUser(db);
      await setFlow(
        db,
        [
          { onayciId: low.id, limit: 5000 },
          { onayciId: mid.id, limit: 50000 },
          { onayciId: high.id, limit: null },
        ],
        'tek',
      );
      const cases: Array<[number, number]> = [
        [0.01, low.id],
        [5000, low.id],
        [5000.01, mid.id],
        [50000, mid.id],
        [50000.01, high.id],
        [1_000_000_000, high.id],
      ];
      for (const [tutar, approver] of cases) {
        const d = await svc.create(sender, form({ tutar }), true);
        expect(chain(d), `${tutar}`).toEqual([{ id: approver, durum: 'bekliyor' }]);
        expect(d.onayTutari).toBe(tutar);
      }
      // A foreign amount is routed by its converted value: 125 × 40 = 5000, 125.01 × 40 = 5000.40.
      const atLimit = await svc.create(sender, form({ tutar: 125, paraBirimi: 'USD', kur: 40 }), true);
      expect(atLimit).toMatchObject({ yerelTutar: 5000, onayTutari: 5000, kur: 40 });
      expect(chain(atLimit)).toEqual([{ id: low.id, durum: 'bekliyor' }]);
      const over = await svc.create(sender, form({ tutar: 125.01, paraBirimi: 'USD', kur: 40 }), true);
      expect(over).toMatchObject({ yerelTutar: 5000.4, onayTutari: 5000.4 });
      expect(chain(over)).toEqual([{ id: mid.id, durum: 'bekliyor' }]);
    });

    it('routes the same approvers and limits by the strategy of the flow, copying the band of each step', async () => {
      const low = await makeUser(db, { adSoyad: 'Alt' });
      const mid = await makeUser(db, { adSoyad: 'Orta' });
      const high = await makeUser(db, { adSoyad: 'Üst' });
      const sender = await makeUser(db);
      const steps = [
        { onayciId: low.id, limit: 5000 },
        { onayciId: mid.id, limit: 50000 },
        { onayciId: high.id, limit: null },
      ];
      const band = (d: MasrafDetay) => d.onaylar.map((o) => [o.onayci.id, o.altLimit, o.ustLimit]);

      await setFlow(db, steps, 'zincir');
      const chained = await svc.create(sender, form({ tutar: 20000 }), true);
      expect(chain(chained)).toEqual([
        { id: low.id, durum: 'bekliyor' },
        { id: mid.id, durum: 'sirada' },
      ]);
      expect(band(chained)).toEqual([
        [low.id, 0, null],
        [mid.id, 5000.01, null],
      ]);
      expect(chained.gecmis[1]?.aciklama).toBe('Onay tutarı 20.000,00 TRY. Onay akışı: Genel. Onaycılar: Alt → Orta.');

      await setFlow(db, steps, 'tek');
      const single = await svc.create(sender, form({ tutar: 20000 }), true);
      expect(chain(single)).toEqual([{ id: mid.id, durum: 'bekliyor' }]);
      expect(band(single)).toEqual([[mid.id, 5000.01, 50000]]);
      expect(single.gecmis[1]?.aciklama).toBe('Onay tutarı 20.000,00 TRY. Onay akışı: Genel. Onaycılar: Orta.');
      expect((await svc.approve(single.id, mid, null)).durum).toBe('onaylandi');

      // The form sent as a chain keeps its steps.
      expect(chain(await svc.detail(chained.id, sender))).toEqual(chain(chained));
    });

    it("skips the sender's own step", async () => {
      const ayse = await makeUser(db);
      const mehmet = await makeUser(db);
      await setFlow(db, chainOf(ayse.id, mehmet.id));
      const d = await svc.create(ayse, form(), true);
      expect(chain(d)).toEqual([
        { id: ayse.id, durum: 'atlandi' },
        { id: mehmet.id, durum: 'bekliyor' },
      ]);
      expect(d.onaylar[0]).toMatchObject({ yedek: false, kararTarihi: expect.any(String), aciklama: expect.stringContaining('Kendi masrafı') });
      expect(d.siradakiOnayci?.id).toBe(mehmet.id);
      expect(events(d)).toEqual(['olusturuldu', 'gonderildi', 'atlandi']);
    });

    it("passes over the sender's own step in the middle of the chain", async () => {
      const first = await makeUser(db);
      const sender = await makeUser(db);
      const last = await makeUser(db);
      await setFlow(db, chainOf(first.id, sender.id, last.id));
      const d = await svc.create(sender, form(), true);
      expect(chain(d)).toEqual([
        { id: first.id, durum: 'bekliyor' },
        { id: sender.id, durum: 'atlandi' },
        { id: last.id, durum: 'sirada' },
      ]);
      const next = await svc.approve(d.id, first, null);
      expect(chain(next)).toEqual([
        { id: first.id, durum: 'onaylandi' },
        { id: sender.id, durum: 'atlandi' },
        { id: last.id, durum: 'bekliyor' },
      ]);
      expect((await svc.approve(d.id, last, null)).durum).toBe('onaylandi');
    });

    it('sends the last approval of the deciding approver\'s own expense one approver up', async () => {
      const ayse = await makeUser(db, { adSoyad: 'Ayşe' });
      const mehmet = await makeUser(db, { adSoyad: 'Mehmet' });
      const zeynep = await makeUser(db, { adSoyad: 'Zeynep' });
      const steps = [
        { onayciId: ayse.id, limit: 5000 },
        { onayciId: mehmet.id, limit: 50000 },
        { onayciId: zeynep.id, limit: null },
      ];
      // The contract's example: Mehmet's 20.000 goes to Ayşe, then to Zeynep.
      await setFlow(db, steps, 'zincir');
      const chained = await svc.create(mehmet, form({ tutar: 20000 }), true);
      expect(chain(chained)).toEqual([
        { id: ayse.id, durum: 'bekliyor' },
        { id: mehmet.id, durum: 'atlandi' },
        { id: zeynep.id, durum: 'sirada' },
      ]);
      expect(chained.onaylar.map((o) => [o.sira, o.yedek])).toEqual([
        [1, false],
        [2, false],
        [3, false],
      ]);
      expect(chained.gecmis[1]?.aciklama).toContain('Onaycılar: Ayşe → Zeynep.');
      expect(chain(await svc.approve(chained.id, ayse, null))[2]).toEqual({ id: zeynep.id, durum: 'bekliyor' });
      expect((await svc.approve(chained.id, zeynep, null)).durum).toBe('onaylandi');

      // With a single approver the one above decides alone; the step keeps its own band.
      await setFlow(db, steps, 'tek');
      const single = await svc.create(ayse, form({ tutar: 3000 }), true);
      expect(single.onaylar.map((o) => [o.onayci.id, o.durum, o.altLimit, o.ustLimit, o.yedek])).toEqual([
        [ayse.id, 'atlandi', 0, 5000, false],
        [mehmet.id, 'bekliyor', 5000.01, 50000, false],
      ]);
    });

    it('sends the top approver\'s own expense to an administrator; without one a chain keeps the approvers below', async () => {
      const ayse = await makeUser(db, { adSoyad: 'Ayşe' });
      const zeynep = await makeUser(db, { adSoyad: 'Zeynep' });
      const steps = [
        { onayciId: ayse.id, limit: 5000 },
        { onayciId: zeynep.id, limit: null },
      ];
      // No administrator: the chain goes on with Ayşe alone, a single approver has nobody left.
      await setFlow(db, steps, 'zincir');
      const chained = await svc.create(zeynep, form({ tutar: 8000 }), true);
      expect(chained.onaylar.map((o) => [o.onayci.id, o.durum, o.yedek])).toEqual([
        [ayse.id, 'bekliyor', false],
        [zeynep.id, 'atlandi', false],
      ]);
      expect((await svc.approve(chained.id, ayse, null)).durum).toBe('onaylandi');
      await setFlow(db, steps, 'tek');
      await fails(svc.create(zeynep, form({ tutar: 8000 }), true), 409, 'onaylayan_yok');

      // With an active administrator outside the flow, they give the last approval in both strategies.
      const admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yedek Yönetici' });
      const single = await svc.create(zeynep, form({ tutar: 8000 }), true);
      expect(single.onaylar.map((o) => [o.onayci.id, o.durum, o.yedek, o.altLimit, o.ustLimit])).toEqual([
        [zeynep.id, 'atlandi', false, 5000.01, null],
        [admin.id, 'bekliyor', true, 0, null],
      ]);
      await setFlow(db, steps, 'zincir');
      const withAdmin = await svc.create(zeynep, form({ tutar: 8000 }), true);
      expect(withAdmin.onaylar.map((o) => [o.onayci.id, o.durum, o.yedek])).toEqual([
        [ayse.id, 'bekliyor', false],
        [zeynep.id, 'atlandi', false],
        [admin.id, 'sirada', true],
      ]);
      expect(withAdmin.gecmis[1]?.aciklama).toContain('Onaycılar: Ayşe → Yedek Yönetici (yedek).');
    });

    it('falls back to an active administrator outside the flow when the sender is the only approver', async () => {
      await makeUser(db, { rol: 'yonetici', aktif: false }); // lower id, but inactive
      const sender = await makeUser(db);
      const admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yedek Yönetici' });
      await setFlow(db, chainOf(sender.id));

      const d = await svc.create(sender, form(), true);
      expect(d.onaylar).toEqual([
        expect.objectContaining({ sira: 1, onayci: { id: sender.id, adSoyad: sender.adSoyad }, durum: 'atlandi', yedek: false }),
        expect.objectContaining({ sira: 2, onayci: { id: admin.id, adSoyad: 'Yedek Yönetici' }, durum: 'bekliyor', yedek: true, altLimit: 0, ustLimit: null }),
      ]);
      expect(d.gecmis[1]?.aciklama).toContain('Yedek Yönetici (yedek)');
      expect((await svc.approve(d.id, admin, null)).durum).toBe('onaylandi');
    });

    it('falls back to another administrator when an administrator sends their own expense', async () => {
      const boss = await makeUser(db, { rol: 'yonetici' });
      const other = await makeUser(db, { rol: 'yonetici' });
      await setFlow(db, chainOf(boss.id));
      const d = await svc.create(boss, form(), true);
      expect(d.onaylar.map((o) => [o.onayci.id, o.durum, o.yedek])).toEqual([
        [boss.id, 'atlandi', false],
        [other.id, 'bekliyor', true],
      ]);
    });

    it('refuses to send with 409 onaylayan_yok when nobody else can approve', async () => {
      const admin = await makeUser(db, { rol: 'yonetici' });
      await makeUser(db, { rol: 'yonetici', aktif: false });
      await setFlow(db, chainOf(admin.id));

      const draft = await svc.create(admin, form(), false);
      await fails(svc.submit(draft.id, admin), 409, 'onaylayan_yok');
      expect(await svc.detail(draft.id, admin)).toMatchObject({ durum: 'taslak', tur: 0, onayTutari: null, onaylar: [] });
      expect(await rows(draft.id)).toEqual([]);
      await fails(svc.create(admin, form(), true), 409, 'onaylayan_yok');
    });

    it('keeps the approvers of a sent form when the flow changes later', async () => {
      const ayse = await makeUser(db);
      const mehmet = await makeUser(db);
      const sender = await makeUser(db);
      await setFlow(db, chainOf(ayse.id));
      const d = await svc.create(sender, form(), true);

      await setFlow(db, chainOf(mehmet.id));
      expect(chain(await svc.detail(d.id, sender))).toEqual([{ id: ayse.id, durum: 'bekliyor' }]);
      await fails(svc.approve(d.id, mehmet, null), 404, 'bulunamadi');
      expect((await svc.approve(d.id, ayse, null)).durum).toBe('onaylandi');
    });

    it("routes each sender through their own flow; unassigned senders use the default", async () => {
      const ayse = await makeUser(db, { adSoyad: 'Ayşe' });
      const mehmet = await makeUser(db, { adSoyad: 'Mehmet' });
      const zeynep = await makeUser(db, { adSoyad: 'Zeynep' });
      const plain = await makeUser(db);
      const sales = await makeUser(db);
      await setFlow(db, chainOf(ayse.id));
      const satis = await makeFlow(
        db,
        'Satış',
        [
          { onayciId: mehmet.id, limit: 5000 },
          { onayciId: zeynep.id, limit: null },
        ],
        'tek',
      );
      await assignFlow(db, sales.id, satis);

      expect(chain(await svc.create(plain, form({ tutar: 3000 }), true))).toEqual([{ id: ayse.id, durum: 'bekliyor' }]);
      const small = await svc.create(sales, form({ tutar: 3000 }), true);
      expect(chain(small)).toEqual([{ id: mehmet.id, durum: 'bekliyor' }]);
      expect(small.gecmis[1]?.aciklama).toBe('Onay tutarı 3.000,00 TRY. Onay akışı: Satış. Onaycılar: Mehmet.');
      expect(chain(await svc.create(sales, form({ tutar: 9000 }), true))).toEqual([{ id: zeynep.id, durum: 'bekliyor' }]);
    });

    it('keeps a sent form on its approvers when the sender moves to another flow', async () => {
      const ayse = await makeUser(db);
      const mehmet = await makeUser(db);
      const sender = await makeUser(db);
      await setFlow(db, chainOf(ayse.id));
      const d = await svc.create(sender, form(), true);
      await assignFlow(db, sender.id, await makeFlow(db, 'Satış', chainOf(mehmet.id)));
      expect(chain(await svc.detail(d.id, sender))).toEqual([{ id: ayse.id, durum: 'bekliyor' }]);
      // The next round (after a withdrawal) uses the new flow.
      await svc.withdraw(d.id, sender);
      expect(chain(await svc.submit(d.id, sender))).toEqual([{ id: mehmet.id, durum: 'bekliyor' }]);
    });

    it("skips the sender's own step in their flow and falls back to an administrator", async () => {
      const admin = await makeUser(db, { rol: 'yonetici' });
      const lead = await makeUser(db);
      await setFlow(db, chainOf(admin.id));
      await assignFlow(db, lead.id, await makeFlow(db, 'Ekip', chainOf(lead.id)));
      const d = await svc.create(lead, form(), true);
      expect(d.onaylar.map((o) => [o.onayci.id, o.durum, o.yedek])).toEqual([
        [lead.id, 'atlandi', false],
        [admin.id, 'bekliyor', true],
      ]);
    });
  });

  describe('approval amount', () => {
    let low: Kullanici;
    let high: Kullanici;
    let sender: Kullanici;

    beforeEach(async () => {
      low = await makeUser(db);
      high = await makeUser(db);
      sender = await makeUser(db);
      await setFlow(
        db,
        [
          { onayciId: low.id, limit: 5000 },
          { onayciId: high.id, limit: null },
        ],
        'tek',
      );
    });

    it('routes by the invoice total when it is larger than the declared amount', async () => {
      const faturaId = await makeInvoice(db, sender.id, { genelToplam: 6000, paraBirimi: 'TRY' });
      const d = await svc.create(sender, form({ tutar: 4000, faturaIdler: [faturaId] }), true);
      expect(d).toMatchObject({ tutar: 4000, yerelTutar: 4000, onayTutari: 6000, faturaIdler: [faturaId], tutarFarki: { fatura: 6000, beyan: 4000 } });
      expect(chain(d)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
      expect(d.faturalar).toEqual([
        expect.objectContaining({ id: faturaId, dosyaAdi: 'fatura.pdf', dosyaVar: true, mime: 'application/pdf', genelToplam: 6000, paraBirimi: 'TRY' }),
      ]);
    });

    it('keeps the declared amount when it is the larger one', async () => {
      const faturaId = await makeInvoice(db, sender.id, { genelToplam: 1800 });
      const d = await svc.create(sender, form({ tutar: 7000, faturaIdler: [faturaId] }), true);
      expect(d).toMatchObject({ onayTutari: 7000, tutarFarki: { fatura: 1800, beyan: 7000 } });
      expect(chain(d)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
    });

    it('shows no difference when the declared amount matches the invoice', async () => {
      const faturaId = await makeInvoice(db, sender.id, { genelToplam: 1800 });
      const d = await svc.create(sender, form({ tutar: 1800, faturaIdler: [faturaId] }), true);
      expect(d).toMatchObject({ onayTutari: 1800, tutarFarki: null });
    });

    it("converts a foreign invoice total with the form's rate", async () => {
      const faturaId = await makeInvoice(db, sender.id, { genelToplam: 150, paraBirimi: 'USD' });
      const d = await svc.create(sender, form({ tutar: 100, paraBirimi: 'USD', kur: 40, faturaIdler: [faturaId] }), true);
      expect(d).toMatchObject({ yerelTutar: 4000, onayTutari: 6000, tutarFarki: { fatura: 150, beyan: 100 } });
      expect(chain(d)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
    });

    it('asks for the base-currency equivalent of an invoice in another currency before sending', async () => {
      const faturaId = await makeInvoice(db, sender.id, { genelToplam: 150, paraBirimi: 'EUR' });
      // Sending without it is refused, and the form is not created either.
      const err = await svc.create(sender, form({ tutar: 100, faturaIdler: [faturaId] }), true).catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 409,
        code: 'karsilik_eksik',
        message: 'Fatura EUR cinsinden; onaya göndermek için TRY karşılığını girin.',
        details: { alanlar: { [`yerelKarsiliklar.${faturaId}`]: expect.any(String) } },
      });
      expect((await svc.list(sender, { kapsam: 'benim', sayfa: 1, adet: 20 })).toplam).toBe(0);

      // A draft may wait for it; the invoice does not count until then.
      const draft = await svc.create(sender, form({ tutar: 100, faturaIdler: [faturaId] }), false);
      expect(draft.faturalar[0]).toMatchObject({ paraBirimi: 'EUR', karsilikGerekli: true, yerelKarsilik: null });
      expect(draft.tutarFarki).toBeNull();
      await fails(svc.submit(draft.id, sender), 409, 'karsilik_eksik');

      const filled = await svc.update(draft.id, sender, { yerelKarsiliklar: { [faturaId]: 6000 } });
      expect(filled.faturalar[0]).toMatchObject({ karsilikGerekli: true, yerelKarsilik: 6000 });
      expect(filled.tutarFarki).toEqual({ fatura: 6000, beyan: 100 });
      const sent = await svc.submit(draft.id, sender);
      expect(sent.onayTutari).toBe(6000);
      expect(chain(sent)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
    });

    it('counts a base-currency invoice on a foreign-currency form as it is', async () => {
      const lira = await makeInvoice(db, sender.id, { genelToplam: 6000, paraBirimi: 'TRY' });
      const d = await svc.create(sender, form({ tutar: 100, paraBirimi: 'USD', kur: 40, faturaIdler: [lira] }), true);
      expect(d.faturalar[0]).toMatchObject({ karsilikGerekli: false, yerelKarsilik: null });
      expect(d).toMatchObject({ yerelTutar: 4000, onayTutari: 6000, tutarFarki: { fatura: 150, beyan: 100 } });
      expect(chain(d)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
    });

    it('routes by the invoice of an edited, resent form', async () => {
      const draft = await svc.create(sender, form({ tutar: 4000 }), false);
      const faturaId = await makeInvoice(db, sender.id, { genelToplam: 6000 });
      await svc.update(draft.id, sender, { faturaIdler: [faturaId] });
      const d = await svc.submit(draft.id, sender);
      expect(d.onayTutari).toBe(6000);
      expect(chain(d)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
    });

    it('previews the amount the form would be routed by', async () => {
      const mine = await makeInvoice(db, sender.id, { genelToplam: 6000 });
      expect(await svc.preview(sender, { tutar: 4000, faturaIdler: [mine] })).toEqual({
        onayTutari: 6000,
        paraBirimi: 'TRY',
        akis: { id: await defaultFlowId(db), ad: 'Genel', varsayilan: true },
        adimlar: [{ sira: 1, onayci: { id: high.id, adSoyad: high.adSoyad }, durum: 'sirada', yedek: false }],
        uyari: null,
      });
      // Someone else's invoice does not count.
      const theirs = await makeInvoice(db, low.id, { genelToplam: 6000 });
      expect((await svc.preview(sender, { tutar: 4000, faturaIdler: [theirs] })).onayTutari).toBe(4000);
    });

    it('routes by the sum of several invoices in the form currency', async () => {
      const hotel = await makeInvoice(db, sender.id, { genelToplam: 3000, faturaNo: 'OTEL-1' });
      const taxi = await makeInvoice(db, sender.id, { genelToplam: 2500, faturaNo: 'TAKSI-1' });
      const dinner = await makeInvoice(db, sender.id, { genelToplam: 999, paraBirimi: 'EUR' });
      const d = await svc.create(sender, form({ tutar: 4000, faturaIdler: [taxi, hotel, dinner], yerelKarsiliklar: { [dinner]: 40 } }), true);
      // 2500 + 3000 + 40 (the EUR invoice's entered equivalent) = 5540 > 5000: the higher tier.
      expect(d).toMatchObject({ onayTutari: 5540, tutarFarki: { fatura: 5540, beyan: 4000 }, faturaIdler: [taxi, hotel, dinner] });
      expect(d.faturalar.map((x) => x.faturaNo)).toEqual(['TAKSI-1', 'OTEL-1', 'ABC2026000000123']);
      expect(chain(d)).toEqual([{ id: high.id, durum: 'bekliyor' }]);
      const preview = await svc.preview(sender, { tutar: 4000, faturaIdler: [taxi, hotel, dinner], yerelKarsiliklar: { [dinner]: 40 } });
      expect(preview.onayTutari).toBe(5540);
      // Without the equivalent the preview leaves the EUR invoice out.
      expect((await svc.preview(sender, { tutar: 4000, faturaIdler: [taxi, hotel, dinner] })).onayTutari).toBe(5500);
      // In the list too, in order.
      expect((await svc.list(sender, { kapsam: 'benim', sayfa: 1, adet: 20 })).kayitlar[0]?.faturaIdler).toEqual([taxi, hotel, dinner]);
    });

    it('counts only the uploader\'s own invoices in a preview of several', async () => {
      const mine = await makeInvoice(db, sender.id, { genelToplam: 3000 });
      const theirs = await makeInvoice(db, low.id, { genelToplam: 3000 });
      expect((await svc.preview(sender, { tutar: 100, faturaIdler: [mine, theirs, mine] })).onayTutari).toBe(3000);
    });
  });

  describe('life cycle', () => {
    let a: Kullanici;
    let b: Kullanici;
    let c: Kullanici;
    let sender: Kullanici;
    let admin: Kullanici;
    let accounting: Kullanici;

    beforeEach(async () => {
      a = await makeUser(db, { adSoyad: 'Onaycı A' });
      b = await makeUser(db, { adSoyad: 'Onaycı B' });
      c = await makeUser(db, { adSoyad: 'Onaycı C' });
      sender = await makeUser(db, { adSoyad: 'Gönderen' });
      admin = await makeUser(db, { rol: 'yonetici' });
      accounting = await makeUser(db, { rol: 'muhasebe' });
      await setFlow(db, chainOf(a.id, b.id, c.id));
    });

    it('rejects: the form is reddedildi and the remaining steps are cancelled', async () => {
      const f = await svc.create(sender, form(), true);
      await svc.approve(f.id, a, null);
      const d = await svc.reject(f.id, b, 'Fiş okunmuyor');
      expect(d).toMatchObject({ durum: 'reddedildi', siradakiOnayci: null, sonuclanma: expect.any(String) });
      expect(chain(d)).toEqual([
        { id: a.id, durum: 'onaylandi' },
        { id: b.id, durum: 'reddedildi' },
        { id: c.id, durum: 'iptal' },
      ]);
      expect(d.onaylar[1]).toMatchObject({ aciklama: 'Fiş okunmuyor', kararTarihi: expect.any(String) });
      expect(d.gecmis.at(-1)).toMatchObject({ islem: 'reddedildi', kullanici: { id: b.id, adSoyad: 'Onaycı B' }, aciklama: 'Fiş okunmuyor' });
      expect((await svc.detail(f.id, sender)).izinler).toEqual(allow('duzenle', 'gonder', 'iptal'));
      await fails(svc.approve(f.id, c, null), 409, 'onay_beklemiyor');
    });

    it('resubmits an edited, rejected form as a new round copied from the flow as it is now', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await svc.create(sender, form(), true);
      await svc.reject(f.id, a, 'Eksik');
      await setFlow(db, chainOf(c.id));

      const edited = await svc.update(f.id, sender, { tutar: 250, baslik: 'Düzeltildi' });
      expect(edited).toMatchObject({ durum: 'reddedildi', tur: 1, tutar: 250, yerelTutar: 250, baslik: 'Düzeltildi' });

      const again = await svc.submit(f.id, sender);
      expect(again).toMatchObject({ durum: 'onayda', tur: 2, onayTutari: 250, sonuclanma: null });
      expect(chain(again)).toEqual([{ id: c.id, durum: 'bekliyor' }]);
      expect(again.onaylar.every((o) => o.tur === 2)).toBe(true);
      expect(events(again)).toEqual(['olusturuldu', 'gonderildi', 'reddedildi', 'guncellendi', 'gonderildi']);

      // The first round stays in the history tables untouched.
      expect(await rows(f.id)).toEqual([
        { tur: 1, sira: 1, onayci_id: a.id, durum: 'reddedildi' },
        { tur: 1, sira: 2, onayci_id: b.id, durum: 'iptal' },
        { tur: 2, sira: 1, onayci_id: c.id, durum: 'bekliyor' },
      ]);
      // The approver of the old round still sees the form but has nothing to decide.
      expect((await svc.detail(f.id, a)).izinler).toEqual(NONE);
      await fails(svc.approve(f.id, a, null), 409, 'onay_beklemiyor');
      expect((await svc.approve(f.id, c, null)).durum).toBe('onaylandi');
    });

    it('withdraws a form under approval back to draft and cancels its open steps', async () => {
      const f = await svc.create(sender, form(), true);
      await svc.approve(f.id, a, null);
      const d = await svc.withdraw(f.id, sender);
      expect(d).toMatchObject({ durum: 'taslak', siradakiOnayci: null });
      expect(chain(d)).toEqual([
        { id: a.id, durum: 'onaylandi' },
        { id: b.id, durum: 'iptal' },
        { id: c.id, durum: 'iptal' },
      ]);
      expect(d.izinler).toEqual(allow('duzenle', 'gonder', 'iptal'));
      expect(events(d).at(-1)).toBe('geri_cekildi');
      expect(await svc.pendingCount(b)).toBe(0);
      expect(await svc.inbox(b, 'bekleyen')).toEqual([]);

      const again = await svc.submit(f.id, sender);
      expect(again.tur).toBe(2);
      expect(chain(again)).toEqual([
        { id: a.id, durum: 'bekliyor' },
        { id: b.id, durum: 'sirada' },
        { id: c.id, durum: 'sirada' },
      ]);
    });

    it('lets only the owner withdraw, and only while the form is under approval', async () => {
      const f = await svc.create(sender, form(), true);
      await fails(svc.withdraw(f.id, a), 403, 'yetki_yok');
      await fails(svc.withdraw(f.id, admin), 403, 'yetki_yok');
      const draft = await svc.create(sender, form(), false);
      await fails(svc.withdraw(draft.id, sender), 409, 'gecersiz_durum');
      await svc.approve(f.id, a, null);
      await svc.approve(f.id, b, null);
      await svc.approve(f.id, c, null);
      await fails(svc.withdraw(f.id, sender), 409, 'gecersiz_durum');
    });

    it('cancels drafts and rejected forms, not forms under approval', async () => {
      const draft = await svc.create(sender, form(), false);
      const cancelled = await svc.cancel(draft.id, sender);
      expect(cancelled.durum).toBe('iptal');
      expect(cancelled.izinler).toEqual(NONE);
      expect(events(cancelled)).toEqual(['olusturuldu', 'iptal_edildi']);
      await fails(svc.cancel(draft.id, sender), 409, 'gecersiz_durum');

      const sent = await svc.create(sender, form(), true);
      await fails(svc.cancel(sent.id, sender), 409, 'gecersiz_durum');
      await fails(svc.cancel(sent.id, a), 403, 'yetki_yok');
      await svc.reject(sent.id, a, 'Hayır');
      expect((await svc.cancel(sent.id, sender)).durum).toBe('iptal');
      await fails(svc.submit(sent.id, sender), 409, 'gecersiz_durum');
      await fails(svc.update(sent.id, sender, { tutar: 5 }), 409, 'gecersiz_durum');
    });

    it('lets accounting and administrators mark only approved forms paid', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(sender, form(), true);
      await fails(svc.markPaid(f.id, accounting), 409, 'gecersiz_durum');
      await svc.approve(f.id, a, null);
      await fails(svc.markPaid(f.id, sender), 403, 'yetki_yok');
      await fails(svc.markPaid(f.id, a), 403, 'yetki_yok');

      const paid = await svc.markPaid(f.id, accounting);
      expect(paid).toMatchObject({ durum: 'odendi', odeme: expect.any(String) });
      expect(paid.gecmis.at(-1)).toMatchObject({ islem: 'odendi', kullanici: { id: accounting.id } });
      expect(paid.izinler).toEqual(NONE);
      await fails(svc.markPaid(f.id, admin), 409, 'gecersiz_durum');

      const other = await svc.create(sender, form(), true);
      await svc.approve(other.id, a, null);
      expect((await svc.markPaid(other.id, admin)).durum).toBe('odendi');
    });

    it('lets an administrator hand an undecided step to another active user', async () => {
      const d = await svc.create(sender, form(), true);
      const stepA = d.onaylar[0]?.id ?? 0;
      const stepC = d.onaylar[2]?.id ?? 0;
      const newcomer = await makeUser(db, { adSoyad: 'Yeni Onaycı' });

      await fails(svc.reassign(d.id, accounting, stepA, newcomer.id), 403, 'yetki_yok');
      await fails(svc.reassign(d.id, a, stepA, newcomer.id), 403, 'yetki_yok');

      const moved = await svc.reassign(d.id, admin, stepA, newcomer.id);
      expect(chain(moved)).toEqual([
        { id: newcomer.id, durum: 'bekliyor' },
        { id: b.id, durum: 'sirada' },
        { id: c.id, durum: 'sirada' },
      ]);
      expect(moved.siradakiOnayci?.id).toBe(newcomer.id);
      expect(moved.gecmis.at(-1)).toMatchObject({ islem: 'devredildi', kullanici: { id: admin.id }, aciklama: '1. adım: Onaycı A → Yeni Onaycı' });
      // The previous approver no longer has a step in the form.
      await fails(svc.approve(d.id, a, null), 404, 'bulunamadi');
      expect(chain(await svc.approve(d.id, newcomer, null))[1]).toEqual({ id: b.id, durum: 'bekliyor' });

      // A step further down the chain can be handed over too.
      const later = await svc.reassign(d.id, admin, stepC, a.id);
      expect(chain(later)[2]).toEqual({ id: a.id, durum: 'sirada' });
    });

    it('refuses to hand a step to an inactive user, the sender, its approver or someone already waiting', async () => {
      const d = await svc.create(sender, form(), true);
      const stepA = d.onaylar[0]?.id ?? 0;
      const inactive = await makeUser(db, { aktif: false });
      const field = async (promise: Promise<unknown>, alan: string): Promise<void> => {
        const err = (await promise.then(
          () => null,
          (e: unknown) => e,
        )) as { status: number; code: string; details?: { alanlar?: Record<string, string> } } | null;
        expect(err).toMatchObject({ status: 400, code: 'gecersiz_istek' });
        expect(Object.keys(err?.details?.alanlar ?? {})).toEqual([alan]);
      };
      await field(svc.reassign(d.id, admin, stepA, inactive.id), 'yeniOnayciId');
      await field(svc.reassign(d.id, admin, stepA, 999_999), 'yeniOnayciId');
      await field(svc.reassign(d.id, admin, stepA, sender.id), 'yeniOnayciId');
      await field(svc.reassign(d.id, admin, stepA, a.id), 'yeniOnayciId');
      await field(svc.reassign(d.id, admin, stepA, b.id), 'yeniOnayciId'); // b already waits further down
      await field(svc.reassign(d.id, admin, 999_999, admin.id), 'onayId');
      await svc.approve(d.id, a, null);
      await field(svc.reassign(d.id, admin, stepA, admin.id), 'onayId'); // decided steps stay as they are
      expect(chain(await svc.detail(d.id, admin))).toEqual([
        { id: a.id, durum: 'onaylandi' },
        { id: b.id, durum: 'bekliyor' },
        { id: c.id, durum: 'sirada' },
      ]);

      const draft = await svc.create(sender, form(), false);
      await fails(svc.reassign(draft.id, admin, stepA, admin.id), 409, 'gecersiz_durum');
    });
  });

  describe('who may do what', () => {
    let a: Kullanici;
    let b: Kullanici;
    let owner: Kullanici;
    let outsider: Kullanici;
    let admin: Kullanici;
    let accounting: Kullanici;

    beforeEach(async () => {
      a = await makeUser(db);
      b = await makeUser(db);
      owner = await makeUser(db);
      outsider = await makeUser(db);
      admin = await makeUser(db, { rol: 'yonetici' });
      accounting = await makeUser(db, { rol: 'muhasebe' });
      await setFlow(db, chainOf(a.id, b.id));
    });

    it('hides a form from employees who neither own nor approve it', async () => {
      const f = await svc.create(owner, form(), true);
      await fails(svc.detail(f.id, outsider), 404, 'bulunamadi');
      await fails(svc.approve(f.id, outsider, null), 404, 'bulunamadi');
      await fails(svc.reject(f.id, outsider, 'Hayır'), 404, 'bulunamadi');
      await fails(svc.withdraw(f.id, outsider), 404, 'bulunamadi');
      const draft = await svc.create(owner, form(), false);
      await fails(svc.update(draft.id, outsider, { tutar: 1 }), 404, 'bulunamadi');
      await fails(svc.submit(draft.id, outsider), 404, 'bulunamadi');
      await fails(svc.cancel(draft.id, outsider), 404, 'bulunamadi');
      await fails(svc.detail(999_999, owner), 404, 'bulunamadi');
      // Approvers further down the chain already see it; accounting and administrators see everything.
      expect((await svc.detail(f.id, b)).id).toBe(f.id);
      expect((await svc.detail(f.id, accounting)).id).toBe(f.id);
      expect((await svc.detail(draft.id, admin)).id).toBe(draft.id);
    });

    it('lets only the waiting approver decide', async () => {
      const f = await svc.create(owner, form(), true);
      await fails(svc.approve(f.id, owner, null), 409, 'onay_beklemiyor');
      await fails(svc.approve(f.id, b, null), 409, 'onay_beklemiyor');
      await fails(svc.reject(f.id, b, 'Hayır'), 409, 'onay_beklemiyor');
      await fails(svc.approve(f.id, admin, null), 409, 'onay_beklemiyor');
      await fails(svc.approve(f.id, accounting, null), 409, 'onay_beklemiyor');
      await svc.approve(f.id, a, null);
      await fails(svc.approve(f.id, a, null), 409, 'onay_beklemiyor');
      await svc.approve(f.id, b, null);
      await fails(svc.approve(f.id, b, null), 409, 'onay_beklemiyor');
      await fails(svc.reject(f.id, b, 'Hayır'), 409, 'onay_beklemiyor');
    });

    it('lets only the owner edit, and only drafts and rejected forms', async () => {
      const f = await svc.create(owner, form(), true);
      await fails(svc.update(f.id, a, { tutar: 1 }), 403, 'yetki_yok');
      await fails(svc.update(f.id, admin, { tutar: 1 }), 403, 'yetki_yok');
      await fails(svc.update(f.id, owner, { tutar: 1 }), 409, 'gecersiz_durum');
      await fails(svc.submit(f.id, owner), 409, 'gecersiz_durum');
      await svc.reject(f.id, a, 'Hayır');
      expect((await svc.update(f.id, owner, { tutar: 1 })).tutar).toBe(1);
    });

    it('gives each user the actions the form state allows', async () => {
      const draft = await svc.create(owner, form(), false);
      expect(draft.izinler).toEqual(allow('duzenle', 'gonder', 'iptal'));
      expect((await svc.detail(draft.id, admin)).izinler).toEqual(NONE);

      const f = await svc.create(owner, form(), true);
      expect(f.izinler).toEqual(allow('geriCek'));
      expect((await svc.detail(f.id, a)).izinler).toEqual(allow('onayla', 'reddet'));
      expect((await svc.detail(f.id, b)).izinler).toEqual(NONE);
      expect((await svc.detail(f.id, admin)).izinler).toEqual(allow('devret'));
      expect((await svc.detail(f.id, accounting)).izinler).toEqual(NONE);

      await svc.approve(f.id, a, null);
      expect((await svc.detail(f.id, a)).izinler).toEqual(NONE);
      expect((await svc.detail(f.id, b)).izinler).toEqual(allow('onayla', 'reddet'));

      await svc.approve(f.id, b, null);
      expect((await svc.detail(f.id, owner)).izinler).toEqual(NONE);
      expect((await svc.detail(f.id, accounting)).izinler).toEqual(allow('odendi'));
      expect((await svc.detail(f.id, admin)).izinler).toEqual(allow('odendi'));
      expect((await svc.detail(f.id, b)).izinler).toEqual(NONE);

      // An administrator approving their own step sees both sets of actions.
      await setFlow(db, chainOf(admin.id));
      const mine = await svc.create(owner, form(), true);
      expect((await svc.detail(mine.id, admin)).izinler).toEqual(allow('onayla', 'reddet', 'devret'));
    });

    it("lists only the employee's own forms; every form only for accounting and administrators", async () => {
      const draft = await svc.create(owner, form({ baslik: 'Taksi' }), false);
      const sent = await svc.create(owner, form({ baslik: 'Otel', satici: 'Grand Otel' }), true);
      const theirs = await svc.create(outsider, form({ baslik: 'Kırtasiye' }), true);

      const mine = await svc.list(owner, { kapsam: 'benim', sayfa: 1, adet: 20 });
      expect(mine).toMatchObject({ toplam: 2, sayfa: 1, adet: 20 });
      expect(mine.kayitlar.map((k) => k.id)).toEqual([sent.id, draft.id]);
      expect(mine.kayitlar[0]).toMatchObject({ durum: 'onayda', siradakiOnayci: { id: a.id }, olusturan: { id: owner.id }, kategori: { id: 1, ad: 'Yemek', simge: 'yemek' } });
      expect(mine.kayitlar[1]).toMatchObject({ durum: 'taslak', siradakiOnayci: null, gonderim: null, faturaIdler: [] });

      // An approver's own list holds only their own forms.
      expect((await svc.list(a, { kapsam: 'benim', sayfa: 1, adet: 20 })).toplam).toBe(0);
      await fails(svc.list(owner, { kapsam: 'tumu', sayfa: 1, adet: 20 }), 403, 'yetki_yok');

      for (const who of [accounting, admin]) {
        const all = await svc.list(who, { kapsam: 'tumu', sayfa: 1, adet: 20 });
        expect(all.kayitlar.map((k) => k.id)).toEqual([theirs.id, sent.id, draft.id]);
      }
      const onayda = await svc.list(accounting, { kapsam: 'tumu', durum: ['onayda'], sayfa: 1, adet: 20 });
      expect(onayda.kayitlar.map((k) => k.id)).toEqual([theirs.id, sent.id]);
      const search = await svc.list(accounting, { kapsam: 'tumu', q: 'grand', sayfa: 1, adet: 20 });
      expect(search.kayitlar.map((k) => k.id)).toEqual([sent.id]);
      const byNumber = await svc.list(accounting, { kapsam: 'tumu', q: `#${draft.id}`, sayfa: 1, adet: 20 });
      expect(byNumber.kayitlar.map((k) => k.id)).toEqual([draft.id]);
      const page2 = await svc.list(accounting, { kapsam: 'tumu', sayfa: 2, adet: 2 });
      expect(page2).toMatchObject({ toplam: 3, sayfa: 2, adet: 2 });
      expect(page2.kayitlar.map((k) => k.id)).toEqual([draft.id]);
    });
  });

  describe('races', () => {
    let a: Kullanici;
    let b: Kullanici;
    let sender: Kullanici;

    beforeEach(async () => {
      a = await makeUser(db);
      b = await makeUser(db);
      sender = await makeUser(db);
    });

    const outcome = (results: PromiseSettledResult<unknown>[]) => ({
      ok: results.filter((r) => r.status === 'fulfilled').length,
      codes: results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as { code?: string }).code] : [])),
    });

    it('accepts only one of two simultaneous approvals of the same step', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await svc.create(sender, form(), true);
      const results = await Promise.allSettled([svc.approve(f.id, a, null), svc.approve(f.id, a, null)]);
      expect(outcome(results)).toEqual({ ok: 1, codes: ['onay_beklemiyor'] });
      const d = await svc.detail(f.id, sender);
      expect(d.durum).toBe('onayda');
      expect(chain(d)).toEqual([
        { id: a.id, durum: 'onaylandi' },
        { id: b.id, durum: 'bekliyor' },
      ]);
      expect(events(d).filter((e) => e === 'onaylandi')).toHaveLength(1);
    });

    it('completes a single-step form only once', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(sender, form(), true);
      const results = await Promise.allSettled([svc.approve(f.id, a, null), svc.approve(f.id, a, null), svc.approve(f.id, a, null)]);
      expect(outcome(results)).toEqual({ ok: 1, codes: ['onay_beklemiyor', 'onay_beklemiyor'] });
      const d = await svc.detail(f.id, sender);
      expect(d.durum).toBe('onaylandi');
      expect(events(d)).toEqual(['olusturuldu', 'gonderildi', 'onaylandi', 'tamamlandi']);
    });

    it('lets one of a simultaneous approval and rejection win, leaving the steps consistent', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await svc.create(sender, form(), true);
      const results = await Promise.allSettled([svc.approve(f.id, a, null), svc.reject(f.id, a, 'Hayır')]);
      expect(outcome(results)).toEqual({ ok: 1, codes: ['onay_beklemiyor'] });
      const d = await svc.detail(f.id, sender);
      if (results[0]?.status === 'fulfilled') {
        expect(d.durum).toBe('onayda');
        expect(chain(d)).toEqual([
          { id: a.id, durum: 'onaylandi' },
          { id: b.id, durum: 'bekliyor' },
        ]);
      } else {
        expect(d.durum).toBe('reddedildi');
        expect(chain(d)).toEqual([
          { id: a.id, durum: 'reddedildi' },
          { id: b.id, durum: 'iptal' },
        ]);
      }
    });

    it('keeps the steps consistent when the owner withdraws while the approver decides', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await svc.create(sender, form(), true);
      const results = await Promise.allSettled([svc.approve(f.id, a, null), svc.withdraw(f.id, sender)]);
      const d = await svc.detail(f.id, sender);
      expect(d.durum).toBe('taslak');
      expect(results[1]?.status).toBe('fulfilled');
      expect(d.onaylar.filter((o) => o.durum === 'bekliyor' || o.durum === 'sirada')).toEqual([]);
      if (results[0]?.status === 'rejected') expect((results[0].reason as { code: string }).code).toBe('onay_beklemiyor');
    });

    it('sends a draft only once when it is submitted twice at the same time', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const draft = await svc.create(sender, form(), false);
      const results = await Promise.allSettled([svc.submit(draft.id, sender), svc.submit(draft.id, sender)]);
      expect(outcome(results)).toEqual({ ok: 1, codes: ['gecersiz_durum'] });
      expect(await rows(draft.id)).toEqual([
        { tur: 1, sira: 1, onayci_id: a.id, durum: 'bekliyor' },
        { tur: 1, sira: 2, onayci_id: b.id, durum: 'sirada' },
      ]);
    });

    it('lets only one of two simultaneous forms claim the same invoice', async () => {
      await setFlow(db, chainOf(a.id));
      const faturaId = await makeInvoice(db, sender.id);
      const own = await makeInvoice(db, sender.id);
      const results = await Promise.allSettled([
        svc.create(sender, form({ faturaIdler: [faturaId] }), false),
        svc.create(sender, form({ faturaIdler: [own, faturaId] }), true),
      ]);
      expect(outcome(results)).toEqual({ ok: 1, codes: ['fatura_kullaniliyor'] });
      expect((await svc.list(sender, { kapsam: 'benim', sayfa: 1, adet: 20 })).toplam).toBe(1);
    });
  });

  describe('invoices', () => {
    let a: Kullanici;
    let sender: Kullanici;
    let other: Kullanici;

    beforeEach(async () => {
      a = await makeUser(db);
      sender = await makeUser(db);
      other = await makeUser(db);
      await setFlow(db, chainOf(a.id));
    });

    it('attaches only invoices the user uploaded, and says which one is not', async () => {
      const mine = await makeInvoice(db, sender.id);
      const theirs = await makeInvoice(db, other.id);
      const err = await svc.create(sender, form({ faturaIdler: [mine, theirs] }), false).catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 400,
        code: 'gecersiz_istek',
        message: '2. fatura bulunamadı. Yalnızca kendi yüklediğiniz faturaları ekleyebilirsiniz.',
        details: { alanlar: { 'faturaIdler.1': expect.any(String) } },
      });
      await fails(svc.create(sender, form({ faturaIdler: ['20250101-000000-deadbeef'] }), false), 400, 'gecersiz_istek');
      const draft = await svc.create(sender, form(), false);
      await fails(svc.update(draft.id, sender, { faturaIdler: [theirs] }), 400, 'gecersiz_istek');
      expect((await svc.list(sender, { kapsam: 'benim', sayfa: 1, adet: 20 })).toplam).toBe(1);
      expect((await svc.detail(draft.id, sender)).faturalar).toEqual([]);
    });

    it('takes an invoice once per form and at most 20 of them', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 21; i++) ids.push(await makeInvoice(db, sender.id));
      const [x, y] = ids as [string, string];
      const twice = await svc.create(sender, form({ faturaIdler: [x, y, x] }), false).catch((e: unknown) => e);
      expect(twice).toMatchObject({ status: 400, details: { alanlar: { 'faturaIdler.2': 'Aynı fatura bir forma iki kez eklenemez.' } } });
      const many = await svc.create(sender, form({ faturaIdler: ids }), false).catch((e: unknown) => e);
      expect(many).toMatchObject({ status: 400, details: { alanlar: { faturaIdler: 'Bir masrafa en fazla 20 fatura eklenebilir.' } } });
      const full = await svc.create(sender, form({ faturaIdler: ids.slice(0, 20) }), false);
      expect(full.faturaIdler).toEqual(ids.slice(0, 20));
    });

    it('replaces the whole list on update, in the given order, and keeps it when left out', async () => {
      const [x, y, z] = [await makeInvoice(db, sender.id), await makeInvoice(db, sender.id), await makeInvoice(db, sender.id)];
      const draft = await svc.create(sender, form({ faturaIdler: [x, y] }), false);
      expect((await svc.update(draft.id, sender, { tutar: 50 })).faturaIdler).toEqual([x, y]);
      expect((await svc.update(draft.id, sender, { faturaIdler: [z, x] })).faturaIdler).toEqual([z, x]);
      // y is free again once it left the form.
      const other = await svc.create(sender, form({ faturaIdler: [y] }), false);
      expect(other.faturaIdler).toEqual([y]);
      const cleared = await svc.update(draft.id, sender, { faturaIdler: [] });
      expect(cleared).toMatchObject({ faturaIdler: [], faturalar: [], tutarFarki: null });
    });

    it('keeps an invoice on one live form at a time; a cancelled form frees it', async () => {
      const faturaId = await makeInvoice(db, sender.id);
      const extra = await makeInvoice(db, sender.id);
      const first = await svc.create(sender, form({ faturaIdler: [faturaId] }), true);
      const err = await svc.create(sender, form({ faturaIdler: [faturaId] }), false).catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 409,
        code: 'fatura_kullaniliyor',
        message: `Bu fatura #${first.id} numaralı masraf formunda kullanılıyor.`,
        details: { alanlar: { 'faturaIdler.0': expect.any(String) } },
      });
      // Among several, the error names the one in use.
      const many = await svc.create(sender, form({ faturaIdler: [extra, faturaId] }), false).catch((e: unknown) => e);
      expect(many).toMatchObject({
        status: 409,
        message: `2. fatura #${first.id} numaralı masraf formunda kullanılıyor.`,
        details: { alanlar: { 'faturaIdler.1': expect.any(String) } },
      });

      const second = await svc.create(sender, form(), false);
      await fails(svc.update(second.id, sender, { faturaIdler: [faturaId] }), 409, 'fatura_kullaniliyor');

      // A rejected form still holds its invoice; only cancelling frees it.
      await svc.reject(first.id, a, 'Hayır');
      await fails(svc.update(second.id, sender, { faturaIdler: [faturaId] }), 409, 'fatura_kullaniliyor');
      await svc.cancel(first.id, sender);
      const reused = await svc.update(second.id, sender, { faturaIdler: [faturaId] });
      expect(reused.faturaIdler).toEqual([faturaId]);
      // The cancelled form still shows the invoice it had.
      expect((await svc.detail(first.id, sender)).faturalar.map((x) => x.id)).toEqual([faturaId]);
      await fails(svc.create(sender, form({ faturaIdler: [faturaId] }), false), 409, 'fatura_kullaniliyor');
      // The form that holds the invoice may be edited without losing it.
      expect((await svc.update(second.id, sender, { faturaIdler: [faturaId, extra], tutar: 90 })).faturaIdler).toEqual([faturaId, extra]);
      expect((await svc.update(second.id, sender, { faturaIdler: [] })).faturalar).toEqual([]);
    });

    it('keeps an equivalent only for an invoice on the form that needs one', async () => {
      const usd = await makeInvoice(db, sender.id, { genelToplam: 100, paraBirimi: 'USD' });
      const lira = await makeInvoice(db, sender.id, { genelToplam: 50, paraBirimi: 'TRY' });
      const extra = await makeInvoice(db, sender.id, { genelToplam: 10, paraBirimi: 'TRY' });
      const stray = await svc.create(sender, form({ faturaIdler: [usd], yerelKarsiliklar: { [lira]: 10 } }), false).catch((e: unknown) => e);
      expect(stray).toMatchObject({ status: 400, details: { alanlar: { [`yerelKarsiliklar.${lira}`]: 'Bu fatura masrafta yok.' } } });

      // Given for a TRY invoice on a TRY form: not needed, not kept.
      const draft = await svc.create(sender, form({ faturaIdler: [usd, lira], yerelKarsiliklar: { [usd]: 3300, [lira]: 99 } }), false);
      expect(draft.faturalar.map((x) => x.yerelKarsilik)).toEqual([3300, null]);
      // Another list without equivalents keeps those of the invoices that stay.
      const more = await svc.update(draft.id, sender, { faturaIdler: [lira, usd, extra] });
      expect(more.faturalar.map((x) => [x.id, x.yerelKarsilik])).toEqual([
        [lira, null],
        [usd, 3300],
        [extra, null],
      ]);
      // On a USD form the USD invoice goes with the form rate: its equivalent goes away.
      const inUsd = await svc.update(draft.id, sender, { paraBirimi: 'USD', kur: 33 });
      expect(inUsd.faturalar.map((x) => [x.karsilikGerekli, x.yerelKarsilik])).toEqual([
        [false, null],
        [false, null],
        [false, null],
      ]);
      const back = await svc.update(draft.id, sender, { paraBirimi: 'TRY' });
      expect(back.faturalar[1]).toMatchObject({ karsilikGerekli: true, yerelKarsilik: null });
    });

    it('writes added and removed invoices to the history', async () => {
      const [x, y, z] = [await makeInvoice(db, sender.id), await makeInvoice(db, sender.id), await makeInvoice(db, sender.id)];
      const draft = await svc.create(sender, form({ faturaIdler: [x, y] }), false);
      await svc.update(draft.id, sender, { faturaIdler: [y, z] });
      await svc.update(draft.id, sender, { faturaIdler: [z, y] });
      const d = await svc.update(draft.id, sender, { tutar: 70 });
      expect(d.gecmis.filter((g) => g.islem === 'guncellendi').map((g) => g.aciklama)).toEqual([
        '1 fatura eklendi, 1 fatura çıkarıldı.',
        'Faturaların sırası değişti.',
        null,
      ]);
    });

    it("does not name another user's form that holds the same file", async () => {
      // Both uploaded the same file: the stored record is shared, the forms are not.
      const faturaId = await makeInvoice(db, other.id);
      await execute(db, 'INSERT INTO dbo.fatura_yuklemeleri (kayit_id, kullanici_id, dosya_adi) VALUES (@k, @u, N\'kopya.pdf\')', {
        k: p.ascii(faturaId, 24),
        u: p.int(sender.id),
      });
      await svc.create(other, form({ faturaIdler: [faturaId] }), false);
      const err = await svc.create(sender, form({ faturaIdler: [faturaId] }), false).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, code: 'fatura_kullaniliyor', message: 'Bu fatura başka bir masraf formunda kullanılıyor.' });
    });

    it('frees every invoice of a cancelled form', async () => {
      const [x, y] = [await makeInvoice(db, sender.id), await makeInvoice(db, sender.id)];
      const draft = await svc.create(sender, form({ faturaIdler: [x, y] }), false);
      await svc.cancel(draft.id, sender);
      const next = await svc.create(sender, form({ faturaIdler: [y, x] }), false);
      expect(next.faturaIdler).toEqual([y, x]);
    });
  });

  describe('fields', () => {
    let sender: Kullanici;

    beforeEach(async () => {
      sender = await makeUser(db);
    });

    const field = async (promise: Promise<unknown>, alan: string): Promise<void> => {
      const err = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: 400, code: 'gecersiz_istek', details: { alanlar: { [alan]: expect.any(String) } } });
    };

    it('refuses future dates, inactive or unknown categories and foreign amounts without a rate', async () => {
      await field(svc.create(sender, form({ masrafTarihi: '2099-12-31' }), false), 'masrafTarihi');
      await execute(db, 'UPDATE dbo.masraf_kategorileri SET aktif = 0 WHERE id = 9');
      await field(svc.create(sender, form({ kategoriId: 9 }), false), 'kategoriId');
      await field(svc.create(sender, form({ kategoriId: 999 }), false), 'kategoriId');
      await field(svc.create(sender, form({ paraBirimi: 'USD' }), false), 'kur');
      const draft = await svc.create(sender, form(), false);
      await field(svc.update(draft.id, sender, { masrafTarihi: '2099-12-31' }), 'masrafTarihi');
      await field(svc.update(draft.id, sender, { paraBirimi: 'EUR' }), 'kur');
      await field(svc.preview(sender, { tutar: 10, paraBirimi: 'USD' }), 'kur');
      expect((await svc.list(sender, { kapsam: 'benim', sayfa: 1, adet: 20 })).toplam).toBe(1);
    });

    it('stores the local amount, trims text and drops blank optional fields', async () => {
      const d = await svc.create(sender, form({ baslik: '  Uçak bileti ', tutar: 100, paraBirimi: 'USD', kur: 32.5, satici: '  ', aciklama: ' Not ' }), false);
      expect(d).toMatchObject({ baslik: 'Uçak bileti', tutar: 100, paraBirimi: 'USD', kur: 32.5, yerelTutar: 3250, satici: null, aciklama: 'Not', durum: 'taslak', tur: 0 });
      expect(events(d)).toEqual(['olusturuldu']);
      // Back to the base currency: the rate is dropped.
      const back = await svc.update(d.id, sender, { paraBirimi: 'TRY' });
      expect(back).toMatchObject({ paraBirimi: 'TRY', kur: null, yerelTutar: 100 });
    });

    it('never keeps the rate of the previous currency', async () => {
      const d = await svc.create(sender, form({ tutar: 100, paraBirimi: 'USD', kur: 40 }), false);
      await field(svc.update(d.id, sender, { paraBirimi: 'EUR' }), 'kur');
      expect(await svc.detail(d.id, sender)).toMatchObject({ paraBirimi: 'USD', kur: 40, yerelTutar: 4000 });
      expect(await svc.update(d.id, sender, { paraBirimi: 'EUR', kur: 45 })).toMatchObject({ paraBirimi: 'EUR', kur: 45, yerelTutar: 4500 });
      // The same currency again keeps its rate.
      expect(await svc.update(d.id, sender, { paraBirimi: 'EUR', tutar: 200 })).toMatchObject({ kur: 45, yerelTutar: 9000 });
    });
  });

  describe('inbox, summary, preview and export', () => {
    let a: Kullanici;
    let sender: Kullanici;
    let accounting: Kullanici;
    let admin: Kullanici;

    beforeEach(async () => {
      a = await makeUser(db);
      sender = await makeUser(db, { departman: 'Satış' });
      accounting = await makeUser(db, { rol: 'muhasebe' });
      admin = await makeUser(db, { rol: 'yonetici' });
      await setFlow(db, chainOf(a.id));
    });

    it('lists waiting approvals oldest first and decided ones newest first', async () => {
      const f1 = await svc.create(sender, form({ baslik: 'Bir' }), true);
      const f2 = await svc.create(sender, form({ baslik: 'İki' }), true);
      const f3 = await svc.create(sender, form({ baslik: 'Üç' }), true);
      expect((await svc.inbox(a, 'bekleyen')).map((f) => f.id)).toEqual([f1.id, f2.id, f3.id]);
      expect(await svc.pendingCount(a)).toBe(3);
      expect(await svc.inbox(a, 'karar')).toEqual([]);

      await svc.approve(f1.id, a, null);
      await svc.reject(f2.id, a, 'Hayır');
      expect((await svc.inbox(a, 'bekleyen')).map((f) => f.id)).toEqual([f3.id]);
      const decided = await svc.inbox(a, 'karar');
      expect(decided.map((f) => [f.id, f.durum])).toEqual([
        [f2.id, 'reddedildi'],
        [f1.id, 'onaylandi'],
      ]);
      expect(await svc.pendingCount(a)).toBe(1);
      expect(await svc.inbox(sender, 'bekleyen')).toEqual([]);
      expect(await svc.pendingCount(sender)).toBe(0);
    });

    it("summarises the user's own forms and, for accounting and administrators, the company", async () => {
      await svc.create(sender, form({ tutar: 50 }), false);
      await svc.create(sender, form({ tutar: 100 }), true);
      await svc.create(sender, form({ tutar: 200 }), true);
      const approved = await svc.create(sender, form({ tutar: 300 }), true);
      await svc.approve(approved.id, a, null);
      const rejected = await svc.create(sender, form({ tutar: 400 }), true);
      await svc.reject(rejected.id, a, 'Hayır');
      const paid = await svc.create(sender, form({ tutar: 500 }), true);
      await svc.approve(paid.id, a, null);
      await svc.markPaid(paid.id, accounting);
      const cancelled = await svc.create(sender, form({ tutar: 60 }), false);
      await svc.cancel(cancelled.id, sender);

      const mine = await svc.summary(sender);
      expect(mine).toMatchObject({
        paraBirimi: 'TRY',
        benim: { taslak: 1, onayda: 2, onaylandi: 1, reddedildi: 1, odendi: 1, buAyToplam: 1500, bekleyenTutar: 300 },
        bekleyenOnay: 0,
        genel: null,
      });
      expect(mine.sonMasraflar.map((f) => f.id)).toEqual([cancelled.id, paid.id, rejected.id, approved.id, mine.sonMasraflar[4]?.id]);
      expect(mine.sonMasraflar).toHaveLength(5);

      expect((await svc.summary(a)).bekleyenOnay).toBe(2);
      const expected = { onayda: 2, odemeBekleyen: 1, odemeBekleyenTutar: 300, buAyOnaylanan: 800 };
      expect((await svc.summary(accounting)).genel).toEqual(expected);
      expect((await svc.summary(admin)).genel).toEqual(expected);
      expect((await svc.summary(accounting)).benim).toMatchObject({ taslak: 0, onayda: 0, buAyToplam: 0, bekleyenTutar: 0 });
    });

    it('previews who would approve, with a warning instead of an error when nobody can', async () => {
      const b = await makeUser(db);
      await setFlow(db, [
        { onayciId: a.id, limit: 5000 },
        { onayciId: b.id, limit: null },
      ]);
      expect(await svc.preview(sender, { tutar: 20000 })).toEqual({
        onayTutari: 20000,
        paraBirimi: 'TRY',
        akis: { id: await defaultFlowId(db), ad: 'Genel', varsayilan: true },
        adimlar: [
          { sira: 1, onayci: { id: a.id, adSoyad: a.adSoyad }, durum: 'sirada', yedek: false },
          { sira: 2, onayci: { id: b.id, adSoyad: b.adSoyad }, durum: 'sirada', yedek: false },
        ],
        uyari: null,
      });
      // Their own expense: one approver up from the deciding one, or the administrator above the top.
      expect((await svc.preview(a, { tutar: 100 })).adimlar).toEqual([
        { sira: 1, onayci: { id: a.id, adSoyad: a.adSoyad }, durum: 'atlandi', yedek: false },
        { sira: 2, onayci: { id: b.id, adSoyad: b.adSoyad }, durum: 'sirada', yedek: false },
      ]);
      expect((await svc.preview(b, { tutar: 20000 })).adimlar).toEqual([
        { sira: 1, onayci: { id: a.id, adSoyad: a.adSoyad }, durum: 'sirada', yedek: false },
        { sira: 2, onayci: { id: b.id, adSoyad: b.adSoyad }, durum: 'atlandi', yedek: false },
        { sira: 3, onayci: { id: admin.id, adSoyad: admin.adSoyad }, durum: 'sirada', yedek: true },
      ]);
      expect(await svc.preview(sender, { tutar: 50, paraBirimi: 'USD', kur: 40 })).toMatchObject({ onayTutari: 2000, paraBirimi: 'TRY' });

      await setFlow(db, chainOf(admin.id));
      const nobody = await svc.preview(admin, { tutar: 100 });
      expect(nobody).toEqual({ onayTutari: 100, paraBirimi: 'TRY', akis: expect.objectContaining({ ad: 'Genel' }), adimlar: [], uyari: expect.stringContaining('onaylayabilecek') });
      // A preview changes nothing.
      expect((await svc.list(admin, { kapsam: 'tumu', sayfa: 1, adet: 20 })).toplam).toBe(0);
    });

    it("previews the sender's own flow, and lets an administrator try any saved flow", async () => {
      const b = await makeUser(db, { adSoyad: 'Bora' });
      await setFlow(db, chainOf(a.id));
      const satis = await makeFlow(db, 'Satış', chainOf(b.id));
      await assignFlow(db, sender.id, satis);
      expect(await svc.preview(sender, { tutar: 100 })).toMatchObject({
        akis: { id: satis, ad: 'Satış', varsayilan: false },
        adimlar: [{ onayci: { id: b.id }, durum: 'sirada' }],
      });
      expect(await svc.preview(admin, { tutar: 100, akisId: satis })).toMatchObject({ akis: { id: satis }, adimlar: [{ onayci: { id: b.id } }] });
      expect((await svc.preview(admin, { tutar: 100 })).akis?.id).toBe(await defaultFlowId(db));
      await fails(svc.preview(sender, { tutar: 100, akisId: satis }), 403, 'yetki_yok');
      await fails(svc.preview(accounting, { tutar: 100, akisId: satis }), 403, 'yetki_yok');
      await fails(svc.preview(admin, { tutar: 100, akisId: 999_999 }), 404, 'bulunamadi');
    });

    it('exports for accounting and administrators only, filtered by state and date', async () => {
      const faturaId = await makeInvoice(db, sender.id, { faturaNo: 'FTR-1' });
      const second = await makeInvoice(db, sender.id, { faturaNo: 'FTR-2' });
      const jan = await svc.create(sender, form({ masrafTarihi: '2025-01-10' }), false);
      const feb = await svc.create(sender, form({ masrafTarihi: '2025-02-10', paraBirimi: 'EUR', kur: 35 }), true);
      const mar = await svc.create(sender, form({ masrafTarihi: '2025-03-10', faturaIdler: [faturaId, second] }), true);

      await fails(svc.exportRows(sender, {}), 403, 'yetki_yok');
      await fails(svc.exportRows(a, {}), 403, 'yetki_yok');

      const all = await svc.exportRows(accounting, {});
      expect(all.map((r) => r.id)).toEqual([jan.id, feb.id, mar.id]);
      expect(all[1]).toMatchObject({ kur: 35, yerelTutar: 3500, departman: 'Satış', faturaNo: null, sonuclanma: null, odeme: null });
      expect(all[2]).toMatchObject({ faturaNo: 'FTR-1, FTR-2', faturaIdler: [faturaId, second] });
      expect((await svc.exportRows(admin, { durum: ['onayda'] })).map((r) => r.id)).toEqual([feb.id, mar.id]);
      expect((await svc.exportRows(admin, { baslangic: '2025-02-01', bitis: '2025-02-28' })).map((r) => r.id)).toEqual([feb.id]);
      expect((await svc.exportRows(admin, { baslangic: '2025-02-11' })).map((r) => r.id)).toEqual([mar.id]);
    });
  });
});
