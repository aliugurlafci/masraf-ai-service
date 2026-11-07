// Notifications and mails written by the form actions, the outgoing mail box and the reminders against
// the test database (docs/onay-sistemi.md, section 7).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute, p, query, queryOne, transaction, type Db } from '../../src/db/sql.ts';
import { createExpenseService, type ExpenseService, type FormInput } from '../../src/expenses/forms.ts';
import { createOutbox, enqueueTestMail, retryMail, type OutgoingMail } from '../../src/notifications/outbox.ts';
import { remindStep, runReminders } from '../../src/notifications/reminders.ts';
import { listNotifications, notify } from '../../src/notifications/store.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { chainOf, closeTestDb, makeUser, resetDb, setFlow, testDb } from '../db.ts';

const PAST = '2025-06-15';
const form = (over: Partial<FormInput> = {}): FormInput => ({ baslik: 'Müşteri yemeği', kategoriId: 1, masrafTarihi: PAST, tutar: 100, ...over });
const ON = { mailEnabled: true, appUrl: 'http://127.0.0.1:4000' } as const;

describe('notifications', () => {
  let db: Db;
  let svc: ExpenseService;
  let quiet: ExpenseService;
  let a: Kullanici;
  let b: Kullanici;
  let owner: Kullanici;
  let accountant: Kullanici;
  let admin: Kullanici;

  beforeAll(async () => {
    db = await testDb();
    svc = createExpenseService(db, { baseCurrency: 'TRY', notifications: ON });
    quiet = createExpenseService(db, { baseCurrency: 'TRY' });
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
    a = await makeUser(db, { adSoyad: 'Onaycı A' });
    b = await makeUser(db, { adSoyad: 'Onaycı B' });
    owner = await makeUser(db, { adSoyad: 'Form Sahibi' });
    accountant = await makeUser(db, { rol: 'muhasebe', adSoyad: 'Muhasebe' });
    admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    await setFlow(db, chainOf(a.id, b.id));
  });

  const notes = () =>
    query<{ kullanici_id: number; tur: string; form_id: number | null; mesaj: string }>(db, 'SELECT kullanici_id, tur, form_id, mesaj FROM dbo.bildirimler ORDER BY id');
  const mails = () =>
    query<{ id: number; alici_id: number | null; adres: string; durum: string; ek_turu: string | null; konu: string; html: string }>(
      db,
      'SELECT id, alici_id, adres, durum, ek_turu, konu, html FROM dbo.eposta_kutusu ORDER BY id',
    );
  const kinds = async () => (await notes()).map((n) => [n.kullanici_id, n.tur]);
  const clear = () => execute(db, 'DELETE FROM dbo.bildirimler; DELETE FROM dbo.eposta_kutusu;');

  describe('form actions', () => {
    it('tells each approver in turn, then the owner and the accountants, mailing them with the document for the owner', async () => {
      const f = await svc.create(owner, form(), true);
      expect(await kinds()).toEqual([[a.id, 'onay_bekliyor']]);
      expect((await notes())[0]?.mesaj).toBe('Form Sahibi, "Müşteri yemeği" masrafını (100,00 TRY) onayınıza gönderdi.');

      await clear();
      await svc.approve(f.id, a, null);
      expect(await kinds()).toEqual([[b.id, 'onay_bekliyor']]);

      await clear();
      await svc.approve(f.id, b, null);
      expect(await kinds()).toEqual([
        [owner.id, 'onaylandi'],
        [accountant.id, 'odeme_bekliyor'],
      ]);
      const sent = await mails();
      expect(sent.map((m) => [m.alici_id, m.durum, m.ek_turu])).toEqual([
        [owner.id, 'bekliyor', 'masraf_pdf'],
        [accountant.id, 'bekliyor', null],
      ]);
      expect(sent[0]?.adres).toBe(owner.eposta);
      expect(sent[0]?.html).toContain(`http://127.0.0.1:4000/#/masraflar/${f.id}`);

      await clear();
      await svc.markPaid(f.id, accountant);
      expect(await kinds()).toEqual([[owner.id, 'odendi']]);
    });

    it('tells the owner of a rejection with the reason, and nobody of a withdrawal or a cancellation', async () => {
      const f = await svc.create(owner, form(), true);
      await clear();
      await svc.reject(f.id, a, 'Fiş okunmuyor');
      const [rejected] = await notes();
      expect(rejected).toMatchObject({ kullanici_id: owner.id, tur: 'reddedildi', form_id: f.id });
      expect(rejected?.mesaj).toContain('Onaycı A tarafından reddedildi. Gerekçe: Fiş okunmuyor');

      await clear();
      await svc.submit(f.id, owner);
      await clear();
      await svc.withdraw(f.id, owner);
      await svc.cancel(f.id, owner);
      expect(await notes()).toEqual([]);
    });

    it('tells a new approver of a handed step: waiting now or later', async () => {
      const c = await makeUser(db, { adSoyad: 'Onaycı C' });
      const f = await svc.create(owner, form(), true);
      await clear();
      await svc.reassign(f.id, admin, f.onaylar[1]?.id ?? 0, c.id);
      expect(await kinds()).toEqual([[c.id, 'devredildi']]);
      await clear();
      const d = await makeUser(db);
      await svc.reassign(f.id, admin, f.onaylar[0]?.id ?? 0, d.id);
      expect(await kinds()).toEqual([[d.id, 'onay_bekliyor']]);
    });

    it('does not notify the accountant who approves last of their own action', async () => {
      await setFlow(db, chainOf(accountant.id));
      const f = await svc.create(owner, form(), true);
      await clear();
      await svc.approve(f.id, accountant, null);
      expect(await kinds()).toEqual([[owner.id, 'onaylandi']]);
    });

    it('notifies inactive users and those who turned mail off in the app, but mails neither', async () => {
      const other = await makeUser(db, { rol: 'muhasebe', aktif: false });
      await execute(db, 'UPDATE dbo.kullanicilar SET mail_bildirim = 0 WHERE id = @u', { u: p.int(owner.id) });
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(owner, form(), true);
      await clear();
      await svc.approve(f.id, a, null);
      // Only active accountants wait for payment; the inactive one is not even told.
      expect(await kinds()).toEqual([
        [owner.id, 'onaylandi'],
        [accountant.id, 'odeme_bekliyor'],
      ]);
      expect((await mails()).map((m) => m.alici_id)).toEqual([accountant.id]);
      expect(other.aktif).toBe(false);

      // An inactive approver still gets the in-app notification, not the mail.
      const sleeper = await makeUser(db);
      await setFlow(db, chainOf(sleeper.id));
      await execute(db, 'UPDATE dbo.kullanicilar SET aktif = 0 WHERE id = @u', { u: p.int(sleeper.id) });
      await clear();
      await svc.create(owner, form(), true);
      expect(await kinds()).toEqual([[sleeper.id, 'onay_bekliyor']]);
      expect(await mails()).toEqual([]);
    });

    it('lists a notification with the form title it was written with', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(owner, form({ baslik: 'Eski başlık' }), true);
      await svc.reject(f.id, a, 'Eksik bilgi');
      await svc.update(f.id, owner, { baslik: 'Yeni başlık' });
      const list = await listNotifications(db, a.id, { okunmamis: false, sayfa: 1, adet: 20 });
      expect(list.kayitlar.map((n) => n.form)).toEqual([{ id: f.id, baslik: 'Eski başlık' }]);
    });

    it('writes mails as skipped when mail is off', async () => {
      await quiet.create(owner, form(), true);
      expect((await mails()).map((m) => m.durum)).toEqual(['atlandi']);
    });

    it('leaves no notification behind when the action is rolled back', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(owner, form(), true);
      await clear();
      // Make the mail to the owner fail inside the approval: the whole action is undone.
      await execute(db, `ALTER TABLE dbo.eposta_kutusu ADD CONSTRAINT ck_test_geri_al CHECK (adres <> N'${owner.eposta}')`);
      try {
        await expect(svc.approve(f.id, a, null)).rejects.toMatchObject({ number: 547 });
      } finally {
        await execute(db, 'ALTER TABLE dbo.eposta_kutusu DROP CONSTRAINT ck_test_geri_al');
      }
      expect(await notes()).toEqual([]);
      expect(await mails()).toEqual([]);
      expect((await svc.detail(f.id, owner)).durum).toBe('onayda');

      // The same in a transaction of the caller.
      await expect(
        transaction(db, async (tx) => {
          await notify(tx, { kind: 'odendi', form: { id: f.id, baslik: 'x', sahip: { id: owner.id, adSoyad: 'x' }, tutar: 1, paraBirimi: 'TRY', durum: 'odendi' } }, null, ON);
          throw new Error('geri al');
        }),
      ).rejects.toThrow('geri al');
      expect(await notes()).toEqual([]);
    });
  });

  describe('outgoing mail box', () => {
    const sentBox: OutgoingMail[] = [];
    let failures = 0;
    let clock = new Date();
    const outbox = (maxAttempts = 3) =>
      createOutbox({
        db,
        from: 'Masraf <masraf@firma.test>',
        maxAttempts,
        now: () => clock,
        secrets: ['GizliSmtp1', 'smtp-kullanici'],
        log: () => {},
        attachment: async (formId) => svc.pdfForMail(formId),
        send: async (m) => {
          if (failures > 0) {
            failures--;
            throw Object.assign(new Error('Connection refused (user smtp-kullanici pass GizliSmtp1)'), { code: 'ECONNREFUSED' });
          }
          sentBox.push(m);
        },
      });
    const row = async (id: number) =>
      queryOne<{ durum: string; deneme: number; son_hata: string | null; sonraki_deneme: Date | null; gonderim: Date | null }>(
        db,
        'SELECT durum, deneme, son_hata, sonraki_deneme, gonderim FROM dbo.eposta_kutusu WHERE id = @id',
        { id: p.int(id) },
      );

    beforeEach(() => {
      sentBox.length = 0;
      failures = 0;
      clock = new Date(Date.now() + 1000);
    });

    it('sends due mails once, with the approval document attached for the owner', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(owner, form(), true);
      await svc.approve(f.id, a, null);
      const box = outbox();
      expect(await box.runOnce()).toBe(3);
      expect(await box.runOnce()).toBe(0);
      expect(sentBox.map((m) => m.to)).toEqual([a.eposta, owner.eposta, accountant.eposta]);
      const toOwner = sentBox[1];
      expect(toOwner?.from).toBe('Masraf <masraf@firma.test>');
      expect(toOwner?.attachments).toHaveLength(1);
      expect(toOwner?.attachments?.[0]).toMatchObject({ filename: `masraf-${f.id}.pdf`, contentType: 'application/pdf' });
      expect(toOwner?.attachments?.[0]?.content.subarray(0, 5).toString()).toBe('%PDF-');
      expect(sentBox[0]?.attachments).toBeUndefined();
      expect((await mails()).map((m) => m.durum)).toEqual(['gonderildi', 'gonderildi', 'gonderildi']);
    });

    it('retries after 1, then 5 minutes and gives up after the last attempt, keeping only a clean error', async () => {
      const id = await enqueueTestMail(db, 'kisi@firma.test', null);
      const box = outbox(3);
      failures = 10;
      await box.runOnce();
      let r = await row(id);
      expect(r).toMatchObject({ durum: 'bekliyor', deneme: 1, son_hata: 'ECONNREFUSED: Connection refused (user *** pass ***)' });
      expect(r?.sonraki_deneme?.getTime()).toBe(clock.getTime() + 60_000);

      // Not due yet.
      expect(await box.runOnce()).toBe(0);
      clock = new Date(clock.getTime() + 60_000);
      await box.runOnce();
      r = await row(id);
      expect(r).toMatchObject({ durum: 'bekliyor', deneme: 2 });
      expect(r?.sonraki_deneme?.getTime()).toBe(clock.getTime() + 5 * 60_000);

      clock = new Date(clock.getTime() + 5 * 60_000);
      await box.runOnce();
      expect(await row(id)).toMatchObject({ durum: 'hata', deneme: 3, sonraki_deneme: null });
      expect(sentBox).toEqual([]);

      // Put back by an administrator, it goes out.
      expect((await retryMail(db, id)).sonuc).toBe('tamam');
      expect((await retryMail(db, id)).sonuc).toBe('durum');
      failures = 0;
      clock = new Date(Date.now() + 1000);
      await box.runOnce();
      expect(await row(id)).toMatchObject({ durum: 'gonderildi', deneme: 1, son_hata: null });
      expect(sentBox.map((m) => m.to)).toEqual(['kisi@firma.test']);
    });

    it('never sends skipped mails, and two jobs never send the same mail', async () => {
      await quiet.create(owner, form(), true);
      for (let i = 0; i < 6; i++) await enqueueTestMail(db, `kisi${i}@firma.test`, null);
      const [x, y] = [outbox(), outbox()];
      await Promise.all([x.runOnce(), y.runOnce(), x.runOnce()]);
      expect(sentBox.map((m) => m.to).sort()).toEqual([0, 1, 2, 3, 4, 5].map((i) => `kisi${i}@firma.test`));
      expect((await mails()).filter((m) => m.durum === 'atlandi')).toHaveLength(1);
    });

    it('claims one mail at a time, right before sending it, with a lease longer than one send', async () => {
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await enqueueTestMail(db, `sira${i}@firma.test`, null));
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const slowTo: string[] = [];
      const slow = createOutbox({
        db,
        from: 'm@firma.test',
        maxAttempts: 3,
        now: () => clock,
        leaseMs: 120_000,
        log: () => {},
        attachment: async () => null,
        send: async (m) => {
          slowTo.push(m.to);
          await gate;
        },
      });
      const running = slow.runOnce();
      await new Promise((r) => setTimeout(r, 100));
      // Only the mail being sent is claimed, with its lease; the rest stay free for another process.
      const leased = await query<{ id: number; sonraki_deneme: Date }>(db, `SELECT id, sonraki_deneme FROM dbo.eposta_kutusu WHERE sonraki_deneme > @now`, { now: p.time(clock) });
      expect(leased).toEqual([{ id: ids[0], sonraki_deneme: new Date(clock.getTime() + 120_000) }]);
      expect(await outbox().runOnce()).toBe(2);
      release();
      expect(await running).toBe(1);
      expect(slowTo).toEqual(['sira0@firma.test']);
      expect(sentBox.map((m) => m.to)).toEqual(['sira1@firma.test', 'sira2@firma.test']);
      expect((await mails()).map((m) => m.durum)).toEqual(['gonderildi', 'gonderildi', 'gonderildi']);
    });

    it('stops cleanly', async () => {
      await enqueueTestMail(db, 'kisi@firma.test', null);
      const box = outbox();
      box.start();
      await new Promise((r) => setTimeout(r, 50));
      await box.stop();
      expect(sentBox).toHaveLength(1);
    });
  });

  describe('reminders', () => {
    const settings = { waitHours: 24, hour: 9, minute: 0 };
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

    it('reminds a step waiting longer than the threshold once a day', async () => {
      await setFlow(db, chainOf(a.id, b.id));
      const f = await svc.create(owner, form(), true);
      await clear();
      expect(await runReminders(db, hours(23), settings, ON)).toBe(0);
      const next = hours(25);
      expect(await runReminders(db, next, settings, ON)).toBe(1);
      expect(await kinds()).toEqual([[a.id, 'hatirlatma']]);
      expect((await mails()).map((m) => m.alici_id)).toEqual([a.id]);
      // The same day again: nothing; the next day: again.
      expect(await runReminders(db, new Date(next.getTime() + 60_000), settings, ON)).toBe(0);
      const tomorrow = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1, 9, 5);
      expect(await runReminders(db, tomorrow, settings, ON)).toBe(1);

      // The next step waits from the previous decision, not from the sending (moved back two days).
      await svc.approve(f.id, a, null);
      await execute(db, 'UPDATE dbo.masraf_formlari SET gonderim = DATEADD(HOUR, -48, gonderim) WHERE id = @f', { f: p.int(f.id) });
      await clear();
      expect(await runReminders(db, hours(23), settings, ON)).toBe(0);
      expect(await runReminders(db, hours(25), settings, ON)).toBe(1);
      expect(await kinds()).toEqual([[b.id, 'hatirlatma']]);
    });

    it('reminds the approver the step has when it is reminded, not when it was found', async () => {
      await setFlow(db, chainOf(a.id));
      const f = await svc.create(owner, form(), true);
      const step = f.onaylar[0]?.id ?? 0;
      await clear();
      // The step was found due for a; it is handed to b before the reminder is written.
      await svc.reassign(f.id, admin, step, b.id);
      await clear();
      expect(await remindStep(db, step, hours(25), settings, ON)).toBe(true);
      expect(await kinds()).toEqual([[b.id, 'hatirlatma']]);
      expect((await mails()).map((m) => m.alici_id)).toEqual([b.id]);
      // A withdrawn form is not reminded.
      const other = await svc.create(owner, form(), true);
      await svc.withdraw(other.id, owner);
      expect(await remindStep(db, other.onaylar[0]?.id ?? 0, hours(25), settings, ON)).toBe(false);
    });

    it('does nothing when turned off', async () => {
      await svc.create(owner, form(), true);
      await clear();
      expect(await runReminders(db, hours(100), { ...settings, waitHours: 0 }, ON)).toBe(0);
      expect(await notes()).toEqual([]);
    });
  });
});
