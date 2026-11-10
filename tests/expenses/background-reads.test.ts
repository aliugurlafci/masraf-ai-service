// Forms saved before their files are read (docs/onay-sistemi.md, section 3, "Arka planda okuma ve
// 'okununca gönder'"): the waiting files, how a finished read joins the form, the empty amount filled from
// the invoices, the notifications and the automatic send. The reading queue is a stand-in here.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute, p, query, queryOne, type Db } from '../../src/db/sql.ts';
import { createExpenseService, type ExpenseService, type FormInput, type MasrafDetay, type ReadingLink } from '../../src/expenses/forms.ts';
import type { Invoice } from '../../src/invoice/schema.ts';
import { createInvoiceStorage } from '../../src/invoice/storage.ts';
import type { ReadingStatus } from '../../src/reading/reader.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { chainOf, closeTestDb, makeInvoice, makeUser, resetDb, setFlow, testDb } from '../db.ts';
import { PDF_BYTES, sampleInvoice } from '../helpers.ts';

const PAST = '2025-06-15';
const form = (over: Partial<FormInput> = {}): FormInput => ({ baslik: 'Saha gezisi', kategoriId: 1, masrafTarihi: PAST, ...over });
const notes = (d: MasrafDetay): Array<string | null> => d.gecmis.map((g) => g.aciklama);

/** A different file each time. */
let fileCount = 0;
const newFile = (): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(`% ${++fileCount}\n`)]);
const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The reading queue as the form service sees it: files being read for their senders, and the starts asked for. */
function fakeReading() {
  const running = new Map<string, { buffer: Buffer; name: string; users: Set<number>; status: ReadingStatus }>();
  const started: number[][] = [];
  const link: ReadingLink = {
    file: (hash, userId) => {
      const r = running.get(hash);
      return r === undefined || !r.users.has(userId) ? null : { buffer: r.buffer, mime: 'application/pdf', name: r.name };
    },
    status: (hash) => running.get(hash)?.status ?? null,
    waiting: (ids) => {
      if (ids.length > 0) started.push([...ids]);
    },
  };
  return {
    link,
    started,
    /** `user` sent a file that is now waiting for Claude; returns its SHA-256. */
    sending(user: Kullanici, buffer = newFile(), name = 'fiş.pdf', status: ReadingStatus = { durum: 'sirada', place: { kuyrukSirasi: 2, onundeki: 3 } }): string {
      const hash = hashOf(buffer);
      running.set(hash, { buffer, name, users: new Set([user.id]), status });
      return hash;
    },
    setStatus(hash: string, status: ReadingStatus): void {
      const r = running.get(hash);
      if (r !== undefined) r.status = status;
    },
    finished(hash: string): void {
      running.delete(hash);
    },
  };
}

describe('reading in the background', () => {
  let db: Db;
  let svc: ExpenseService;
  let reading: ReturnType<typeof fakeReading>;
  let approver: Kullanici;
  let owner: Kullanici;
  let taxNo = 0;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
    reading = fakeReading();
    svc = createExpenseService(db, { baseCurrency: 'TRY', reading: reading.link });
    approver = await makeUser(db, { adSoyad: 'Onaycı' });
    owner = await makeUser(db, { adSoyad: 'Sahip' });
    await setFlow(db, chainOf(approver.id));
  });

  const fails = (promise: Promise<unknown>, status: number, code: string, alanlar?: Record<string, string>): Promise<void> =>
    expect(promise).rejects.toMatchObject({ status, code, ...(alanlar === undefined ? {} : { details: { alanlar } }) });

  /** Claude finished the file: its record, uploaded by `user`, as the reader stores it. */
  const readDone = async (user: Kullanici, hash: string, fatura: Partial<Invoice['fatura']> = {}): Promise<string> => {
    reading.finished(hash);
    const storage = createInvoiceStorage(db);
    const sonuc = sampleInvoice({ saticiVergiNo: String(2_000_000_000 + ++taxNo), ...fatura });
    const record = await storage.save({ dosyaAdi: 'fiş.pdf', sonuc, dosyaOzeti: hash, yukleyenId: user.id });
    await storage.addUpload({ kayitId: record.id, kullaniciId: user.id, dosyaAdi: 'fiş.pdf' });
    return record.id;
  };
  /** The waiting row of the file on the form. */
  const waitingId = async (formId: number, hash: string): Promise<number> => {
    const row = await queryOne<{ id: number }>(db, 'SELECT id FROM dbo.bekleyen_faturalar WHERE form_id = @f AND dosya_ozeti = @h', {
      f: p.int(formId),
      h: p.ascii(hash, 64),
    });
    if (row === null) throw new Error('bekleyen fatura yok');
    return row.id;
  };
  const notifications = () =>
    query<{ kullanici_id: number; tur: string; form_id: number | null; mesaj: string }>(db, 'SELECT kullanici_id, tur, form_id, mesaj FROM dbo.bildirimler ORDER BY id');

  describe('a draft without an amount', () => {
    it('saves without an amount and refuses to send it with 409 tutar_eksik', async () => {
      const d = await svc.create(owner, form(), false);
      expect(d).toMatchObject({ durum: 'taslak', tutar: null, yerelTutar: null, tutarFarki: null, okuma: null, okununcaGonder: false, bekleyenFaturalar: [] });
      const list = await svc.list(owner, { kapsam: 'benim', sayfa: 1, adet: 20 });
      expect(list.kayitlar[0]).toMatchObject({ id: d.id, tutar: null, yerelTutar: null, okuma: null });
      await fails(svc.submit(d.id, owner), 409, 'tutar_eksik', { tutar: expect.any(String) });
      await fails(svc.create(owner, form(), true), 409, 'tutar_eksik');
      // Filled in later, it goes.
      const filled = await svc.update(d.id, owner, { tutar: 250 });
      expect(filled).toMatchObject({ tutar: 250, yerelTutar: 250 });
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('lets a draft clear its amount again, but not a rejected form', async () => {
      const d = await svc.create(owner, form({ tutar: 100 }), false);
      expect((await svc.update(d.id, owner, { tutar: null })).tutar).toBeNull();
      await svc.update(d.id, owner, { tutar: 100 });
      await svc.submit(d.id, owner);
      await svc.reject(d.id, approver, 'Eksik');
      await fails(svc.update(d.id, owner, { tutar: null }), 400, 'gecersiz_istek', { tutar: 'Reddedilen masrafın tutarı boş bırakılamaz.' });
    });
  });

  describe('waiting files', () => {
    it('keeps a file still being read on the saved draft, with its place in the queue, and starts its read', async () => {
      const hash = reading.sending(owner, undefined, 'market fişi.pdf');
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash] }), false);
      expect(d.faturaIdler).toEqual([]);
      expect(d.okuma).toEqual({ bekleyen: 1, hatali: 0 });
      expect(d.bekleyenFaturalar).toEqual([
        {
          dosyaOzeti: hash,
          dosyaAdi: 'market fişi.pdf',
          mime: 'application/pdf',
          boyut: expect.any(Number),
          eklenme: expect.any(String),
          durum: 'sirada',
          kuyrukSirasi: 2,
          onundeki: 3,
          hata: null,
          alanlar: {},
          eksikAlanlar: [],
        },
      ]);
      expect(reading.started).toEqual([[await waitingId(d.id, hash)]]);
      expect(notes(d)).toContain('1 fatura okunmayı bekliyor.');

      reading.setStatus(hash, { durum: 'okunuyor', place: null });
      expect((await svc.detail(d.id, owner)).bekleyenFaturalar[0]).toMatchObject({ durum: 'okunuyor', kuyrukSirasi: null, onundeki: null });
      // The read is done but not settled yet: still waiting, without a place.
      reading.finished(hash);
      expect((await svc.detail(d.id, owner)).bekleyenFaturalar[0]).toMatchObject({ durum: 'sirada', kuyrukSirasi: null, onundeki: null });

      // The background reader gets the files without their bytes, and loads each one when its turn comes.
      const id = await waitingId(d.id, hash);
      expect(await svc.waitingFiles()).toEqual([
        { id, formId: d.id, kullanici: { id: owner.id, adSoyad: 'Sahip' }, dosyaAdi: 'market fişi.pdf', dosyaOzeti: hash, mime: 'application/pdf' },
      ]);
      expect(await svc.waitingFiles([id + 1])).toEqual([]);
      expect(await svc.waitingFiles([])).toEqual([]);
      expect(hashOf((await svc.waitingContent(id)) as Buffer)).toBe(hash);
      // Settled, it no longer waits.
      await svc.settleWaiting(id, { kayitId: await readDone(owner, hash) });
      expect(await svc.waitingContent(id)).toBeNull();
      expect(await svc.waitingFiles()).toEqual([]);
    });

    it("refuses a file the server does not have for the user: unknown, or another user's read", async () => {
      const other = await makeUser(db);
      const theirs = reading.sending(other);
      await fails(svc.create(owner, form({ bekleyenFaturalar: ['f'.repeat(64)] }), false), 400, 'gecersiz_istek', {
        'bekleyenFaturalar.0': 'Bu dosya sunucuda bulunamadı; faturayı yeniden yükleyin.',
      });
      await fails(svc.create(owner, form({ bekleyenFaturalar: [theirs] }), false), 400, 'gecersiz_istek', {
        'bekleyenFaturalar.0': expect.any(String),
      });
      expect(await query(db, 'SELECT id FROM dbo.masraf_formlari')).toEqual([]);
    });

    it('adds a file read since the client last looked to the invoices instead of losing it', async () => {
      const hash = reading.sending(owner);
      const kayit = await readDone(owner, hash);
      const first = await makeInvoice(db, owner.id);
      const d = await svc.create(owner, form({ faturaIdler: [first], bekleyenFaturalar: [hash] }), false);
      expect(d.faturaIdler).toEqual([first, kayit]);
      expect(d.bekleyenFaturalar).toEqual([]);
      expect(d.okuma).toBeNull();
      expect(reading.started).toEqual([]);
    });

    it('keeps waiting files left out of an update, drops those left out of a given list, and says so', async () => {
      const a = reading.sending(owner);
      const b = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [a, b] }), false);
      expect((await svc.update(d.id, owner, { baslik: 'Yeni başlık' })).bekleyenFaturalar.map((w) => w.dosyaOzeti)).toEqual([a, b]);
      const kept = await svc.update(d.id, owner, { bekleyenFaturalar: [b] });
      expect(kept.bekleyenFaturalar.map((w) => w.dosyaOzeti)).toEqual([b]);
      expect(notes(kept)).toContain('1 bekleyen fatura çıkarıldı.');
      // A file added in an update starts its read too.
      const c = reading.sending(owner);
      const more = await svc.update(d.id, owner, { bekleyenFaturalar: [b, c] });
      expect(more.okuma).toEqual({ bekleyen: 2, hatali: 0 });
      expect(reading.started.at(-1)).toEqual([await waitingId(d.id, c)]);
    });

    it('counts waiting files toward the 20 invoices of a form', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push(await makeInvoice(db, owner.id));
      await fails(svc.create(owner, form({ faturaIdler: ids, bekleyenFaturalar: [reading.sending(owner)] }), false), 400, 'gecersiz_istek', {
        bekleyenFaturalar: expect.stringContaining('en fazla 20'),
      });
    });

    it('refuses to send while a file waits (409 okuma_suruyor), before storing anything', async () => {
      const d = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [reading.sending(owner)] }), false);
      await fails(svc.submit(d.id, owner), 409, 'okuma_suruyor');
      await fails(svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [reading.sending(owner)] }), true), 409, 'okuma_suruyor');
      expect(await query(db, 'SELECT form_id FROM dbo.bekleyen_faturalar')).toEqual([{ form_id: d.id }]);
    });

    it('starts again a waiting file whose read stopped, when the owner asks to read again', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash] }), false);
      const id = await waitingId(d.id, hash);
      // The read ended but its result could not be stored: the row still waits, with no read running.
      reading.finished(hash);
      reading.started.length = 0;
      const again = await svc.retryReads(d.id, owner);
      expect(reading.started).toEqual([[id]]);
      // Nothing failed, so nothing is written to the history.
      expect(notes(again).filter((n) => n?.includes('yeniden okunuyor'))).toEqual([]);
    });
  });

  describe('a finished read', () => {
    it('joins the end of the invoice list, fills the empty amount and seller, and tells the owner', async () => {
      const first = await makeInvoice(db, owner.id, { genelToplam: 200, saticiUnvan: 'İlk Satıcı' });
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ faturaIdler: [first], bekleyenFaturalar: [hash] }), false);
      const kayit = await readDone(owner, hash, { genelToplam: 300, saticiUnvan: 'Kafe Ltd.' });
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: kayit });

      const after = await svc.detail(d.id, owner);
      expect(after).toMatchObject({ faturaIdler: [first, kayit], bekleyenFaturalar: [], okuma: null, tutar: 500, yerelTutar: 500, satici: 'İlk Satıcı', durum: 'taslak' });
      expect(notes(after)).toContain('Faturaların okunması bitti. Boş bırakılan tutar ve satıcı faturalardan dolduruldu.');
      expect(after.gecmis.at(-1)?.kullanici).toBeNull();
      expect(await notifications()).toEqual([{ kullanici_id: owner.id, tur: 'okuma_bitti', form_id: d.id, mesaj: expect.stringContaining('faturaları okundu') }]);
      // Now it can be sent.
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('keeps the amount and seller the owner entered', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 42, satici: 'Benim yazdığım', bekleyenFaturalar: [hash] }), false);
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: await readDone(owner, hash) });
      const after = await svc.detail(d.id, owner);
      expect(after).toMatchObject({ tutar: 42, satici: 'Benim yazdığım' });
      expect(notes(after)).toContain('Faturaların okunması bitti.');
    });

    it('tells the owner only when the last waiting file is settled', async () => {
      const a = reading.sending(owner);
      const b = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [a, b] }), false);
      await svc.settleWaiting(await waitingId(d.id, a), { kayitId: await readDone(owner, a) });
      expect(await notifications()).toEqual([]);
      expect((await svc.detail(d.id, owner)).okuma).toEqual({ bekleyen: 1, hatali: 0 });
      await svc.settleWaiting(await waitingId(d.id, b), { kayitId: await readDone(owner, b) });
      expect((await notifications()).map((n) => n.tur)).toEqual(['okuma_bitti']);
    });

    it('drops a file that is on the form already, and does nothing for a settled or removed file', async () => {
      const hash = reading.sending(owner);
      const kayit = await readDone(owner, hash);
      // The same file waits on the form while its invoice is on it (a client that sent both).
      const d = await svc.create(owner, form({ faturaIdler: [kayit] }), false);
      await execute(
        db,
        `INSERT INTO dbo.bekleyen_faturalar (form_id, kullanici_id, dosya_adi, dosya_ozeti, mime, boyut, icerik) VALUES (@f, @u, N'a.pdf', @h, 'application/pdf', 3, 0x010203)`,
        { f: p.int(d.id), u: p.int(owner.id), h: p.ascii(hash, 64) },
      );
      const id = await waitingId(d.id, hash);
      await svc.settleWaiting(id, { kayitId: kayit });
      expect(await svc.detail(d.id, owner)).toMatchObject({ faturaIdler: [kayit], bekleyenFaturalar: [] });
      // Again: the row is gone, nothing happens.
      await svc.settleWaiting(id, { kayitId: kayit });
      expect((await notifications()).map((n) => n.tur)).toEqual(['okuma_bitti']);
    });

    it('fails a file whose invoice is on another live form, naming the form only to its owner', async () => {
      const hash = reading.sending(owner);
      const kayit = await readDone(owner, hash);
      const holder = await svc.create(owner, form({ faturaIdler: [kayit] }), false);
      const again = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [again] }), false);
      await svc.settleWaiting(await waitingId(d.id, again), { kayitId: kayit });
      const after = await svc.detail(d.id, owner);
      expect(after.bekleyenFaturalar).toEqual([
        expect.objectContaining({ durum: 'hata', hata: { kod: 'fatura_kullaniliyor', mesaj: `Bu fatura #${holder.id} numaralı masraf formunda kullanılıyor.` } }),
      ]);
      expect(after.okuma).toEqual({ bekleyen: 0, hatali: 1 });
    });

    it('drops the files of a form that was sent or cancelled meanwhile', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 10, bekleyenFaturalar: [hash] }), false);
      const id = await waitingId(d.id, hash);
      // Cancelling takes the waiting files off the form at once.
      await svc.cancel(d.id, owner);
      expect(await query(db, 'SELECT id FROM dbo.bekleyen_faturalar')).toEqual([]);
      await svc.settleWaiting(id, { kayitId: await readDone(owner, hash) });
      expect((await svc.detail(d.id, owner)).faturaIdler).toEqual([]);
      expect(await notifications()).toEqual([]);
    });
  });

  describe('a failed read', () => {
    it('stays on the form as failed, blocks sending and tells the owner; reading again puts it back in the queue', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [hash] }), false);
      const id = await waitingId(d.id, hash);
      reading.finished(hash);
      await svc.settleWaiting(id, { hata: { kod: 'claude_failed', mesaj: 'Claude faturayı okuyamadı.' } });

      const failed = await svc.detail(d.id, owner);
      expect(failed.okuma).toEqual({ bekleyen: 0, hatali: 1 });
      expect(failed.bekleyenFaturalar).toEqual([expect.objectContaining({ durum: 'hata', kuyrukSirasi: null, onundeki: null, hata: { kod: 'claude_failed', mesaj: 'Claude faturayı okuyamadı.' } })]);
      expect(notes(failed)).toContain('Faturaların okunması bitti; bir fatura okunamadı.');
      expect(await notifications()).toEqual([{ kullanici_id: owner.id, tur: 'okuma_hatasi', form_id: d.id, mesaj: expect.stringContaining('bir faturası okunamadı') }]);
      await fails(svc.submit(d.id, owner), 409, 'okuma_hatali');
      expect(await svc.waitingFiles()).toEqual([]);

      // Only the owner reads it again.
      await fails(svc.retryReads(d.id, approver), 404, 'bulunamadi');
      const again = await svc.retryReads(d.id, owner);
      expect(again.okuma).toEqual({ bekleyen: 1, hatali: 0 });
      expect(again.bekleyenFaturalar[0]).toMatchObject({ durum: 'sirada', hata: null });
      expect(notes(again)).toContain('Bir fatura yeniden okunuyor.');
      expect(reading.started.at(-1)).toEqual([id]);
      await svc.settleWaiting(id, { kayitId: await readDone(owner, hash) });
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('can be taken off the form instead', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [hash] }), false);
      await svc.settleWaiting(await waitingId(d.id, hash), { hata: { kod: 'claude_failed', mesaj: 'Okunamadı.' } });
      const cleared = await svc.update(d.id, owner, { bekleyenFaturalar: [] });
      expect(cleared.okuma).toBeNull();
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });
  });

  describe('okununca gönder', () => {
    it('sends the form once its files are read, on the owner\'s behalf, and tells both sides', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash], okununcaGonder: true }), false);
      expect(d).toMatchObject({ durum: 'taslak', okununcaGonder: true });
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: await readDone(owner, hash, { genelToplam: 750 }) });

      const sent = await svc.detail(d.id, owner);
      expect(sent).toMatchObject({ durum: 'onayda', okununcaGonder: false, tutar: 750, onayTutari: 750, siradakiOnayci: { id: approver.id } });
      const send = sent.gecmis.find((g) => g.islem === 'gonderildi');
      expect(send?.aciklama).toMatch(/^Faturalar okununca kendiliğinden gönderildi\. /);
      expect(send?.kullanici?.id).toBe(owner.id);
      expect((await notifications()).map((n) => [n.kullanici_id, n.tur])).toEqual([
        [approver.id, 'onay_bekliyor'],
        [owner.id, 'onaya_gonderildi'],
      ]);
    });

    it('leaves the form a draft and tells the owner why when it cannot be sent', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash], okununcaGonder: true }), false);
      // Nobody can approve: the only approver is gone from the flow.
      await setFlow(db, []);
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: await readDone(owner, hash) });
      const after = await svc.detail(d.id, owner);
      expect(after).toMatchObject({ durum: 'taslak', okununcaGonder: false });
      expect(notes(after).some((n) => n?.startsWith('Okununca gönder: masraf onaya gönderilemedi.'))).toBe(true);
      expect(await notifications()).toEqual([{ kullanici_id: owner.id, tur: 'onaya_gonderilemedi', form_id: d.id, mesaj: expect.stringContaining('onaya gönderilemedi') }]);
    });

    it('waits for a failed file to be read again or removed, then sends', async () => {
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [hash], okununcaGonder: true }), false);
      await svc.settleWaiting(await waitingId(d.id, hash), { hata: { kod: 'claude_failed', mesaj: 'Okunamadı.' } });
      expect(await svc.detail(d.id, owner)).toMatchObject({ durum: 'taslak', okununcaGonder: true });
      // Taking the failed file off leaves nothing to wait for: the form goes at once.
      expect(await svc.update(d.id, owner, { bekleyenFaturalar: [] })).toMatchObject({ durum: 'onayda', okununcaGonder: false });
      expect((await notifications()).map((n) => n.tur)).toEqual(['okuma_hatasi', 'onay_bekliyor']);
    });

    it('sends at once when nothing waits, and ends with a manual send or a withdrawal', async () => {
      // Right after the owner's own save: the answer shows it, so the owner is not notified.
      const now = await svc.create(owner, form({ tutar: 100, okununcaGonder: true }), false);
      expect(now).toMatchObject({ durum: 'onayda', okununcaGonder: false });
      const empty = await svc.create(owner, form({ okununcaGonder: true }), false);
      expect(empty).toMatchObject({ durum: 'taslak', okununcaGonder: false });
      expect(notes(empty).at(-1)).toMatch(/^Okununca gönder: masraf onaya gönderilemedi\. /);

      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [hash], okununcaGonder: true }), false);
      const off = await svc.update(d.id, owner, { okununcaGonder: false });
      expect(off.okununcaGonder).toBe(false);
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: await readDone(owner, hash) });
      expect(await svc.detail(d.id, owner)).toMatchObject({ durum: 'taslak', okununcaGonder: false });
      expect((await notifications()).map((n) => n.tur)).toEqual(['onay_bekliyor', 'okuma_bitti']);
    });
  });

  it('tries at start-up the sends that were left when the server stopped', async () => {
    const hash = reading.sending(owner);
    const d = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [hash], okununcaGonder: true }), false);
    // The file was settled, but the server stopped before the send.
    await execute(db, 'DELETE FROM dbo.bekleyen_faturalar WHERE form_id = @f', { f: p.int(d.id) });
    const other = await svc.create(owner, form({ tutar: 100, bekleyenFaturalar: [reading.sending(owner)], okununcaGonder: true }), false);
    expect(await svc.resumeSends()).toBe(1);
    expect(await svc.detail(d.id, owner)).toMatchObject({ durum: 'onayda', okununcaGonder: false });
    // A form still waiting for a file is left to its read.
    expect(await svc.detail(other.id, owner)).toMatchObject({ durum: 'taslak', okununcaGonder: true });
    expect(await svc.resumeSends()).toBe(0);
  });

  it('lets only one of two forms that wait for the same file take its invoice', async () => {
    const hash = reading.sending(owner);
    const a = await svc.create(owner, form({ bekleyenFaturalar: [hash] }), false);
    const b = await svc.create(owner, form({ bekleyenFaturalar: [hash] }), false);
    const kayit = await readDone(owner, hash);
    await Promise.all([svc.settleWaiting(await waitingId(a.id, hash), { kayitId: kayit }), svc.settleWaiting(await waitingId(b.id, hash), { kayitId: kayit })]);
    const [da, db2] = [await svc.detail(a.id, owner), await svc.detail(b.id, owner)];
    const linked = [da, db2].filter((x) => x.faturaIdler.includes(kayit));
    const failed = [da, db2].filter((x) => x.bekleyenFaturalar[0]?.hata?.kod === 'fatura_kullaniliyor');
    expect(linked).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });
});
