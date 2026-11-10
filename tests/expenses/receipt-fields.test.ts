// Receipt fields, the cost centre and the organisation on expense forms (docs/onay-sistemi.md, section 3,
// "Fiş alanları, masraf merkezi ve zorunluluk kuralları", and section 6, "Masraf formları"): the values
// each receipt carries, the required fields and rules at sending, the history, the approval document and
// the export. The reading queue is a stand-in, as in background-reads.test.ts.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, p, query, queryOne, type Db } from '../../src/db/sql.ts';
import { createRule, updateField, type FieldPatch } from '../../src/definitions/fields.ts';
import { toCsv } from '../../src/expenses/export.ts';
import { createExpenseService, type ExpenseService, type FormInput, type MasrafDetay, type ReadingLink } from '../../src/expenses/forms.ts';
import { renderApprovalPdf, type PdfData } from '../../src/expenses/pdf.ts';
import type { Actor } from '../../src/expenses/rules.ts';
import { createInvoiceStorage } from '../../src/invoice/storage.ts';
import type { Kullanici } from '../../src/users/users.ts';
import {
  assignDefinitions,
  chainOf,
  closeTestDb,
  fieldId,
  makeCostCenter,
  makeInvoice,
  makeOption,
  makeOrganization,
  makeUser,
  optionId,
  resetDb,
  setFlow,
  testDb,
} from '../db.ts';
import { PDF_BYTES, sampleInvoice } from '../helpers.ts';

// The approval document's data is what the form service hands the renderer.
vi.mock('../../src/expenses/pdf.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/expenses/pdf.ts')>();
  return { ...mod, renderApprovalPdf: vi.fn(mod.renderApprovalPdf) };
});

const PAST = '2025-06-15';
const form = (over: Partial<FormInput> = {}): FormInput => ({ baslik: 'Saha gezisi', kategoriId: 1, masrafTarihi: PAST, ...over });
const notes = (d: MasrafDetay): Array<string | null> => d.gecmis.map((g) => g.aciklama);

let fileCount = 0;
const newFile = (): Buffer => Buffer.concat([PDF_BYTES, Buffer.from(`% alan ${++fileCount}\n`)]);
const hashOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Files being read for their senders, as the form service sees the reading queue. */
function fakeReading() {
  const running = new Map<string, { buffer: Buffer; name: string; user: number }>();
  const link: ReadingLink = {
    file: (hash, userId) => {
      const r = running.get(hash);
      return r === undefined || r.user !== userId ? null : { buffer: r.buffer, mime: 'application/pdf', name: r.name };
    },
    status: (hash) => (running.has(hash) ? { durum: 'sirada', place: null } : null),
    waiting: () => {},
  };
  return {
    link,
    sending(user: Kullanici, name = 'fiş.pdf'): string {
      const buffer = newFile();
      const hash = hashOf(buffer);
      running.set(hash, { buffer, name, user: user.id });
      return hash;
    },
    finished(hash: string): void {
      running.delete(hash);
    },
  };
}

describe('receipt fields on expense forms', () => {
  let db: Db;
  let svc: ExpenseService;
  let reading: ReturnType<typeof fakeReading>;
  let approver: Kullanici;
  let owner: Kullanici;
  let admin: Actor;
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
    admin = await makeUser(db, { rol: 'yonetici', adSoyad: 'Yönetici' });
    await setFlow(db, chainOf(approver.id));
  });

  const fails = (promise: Promise<unknown>, status: number, code: string, alanlar?: Record<string, unknown>): Promise<void> =>
    expect(promise).rejects.toMatchObject({ status, code, ...(alanlar === undefined ? {} : { details: { alanlar } }) });
  const setField = async (anahtar: string, patch: FieldPatch): Promise<void> => {
    await updateField(db, admin, await fieldId(db, anahtar), patch);
  };
  const rule = (kosulAlan: string, kosulDegerId: number, hedefler: string[]) => createRule(db, admin, { kosulAlan, kosulDegerId, hedefler });

  /** Claude finished the file: its record, uploaded by `user`, as the reader stores it. */
  const readDone = async (user: Kullanici, hash: string): Promise<string> => {
    reading.finished(hash);
    const storage = createInvoiceStorage(db);
    const record = await storage.save({ dosyaAdi: 'fiş.pdf', sonuc: sampleInvoice({ saticiVergiNo: String(3_000_000_000 + ++taxNo) }), dosyaOzeti: hash, yukleyenId: user.id });
    await storage.addUpload({ kayitId: record.id, kullaniciId: user.id, dosyaAdi: 'fiş.pdf' });
    return record.id;
  };
  const waitingId = async (formId: number, hash: string): Promise<number> => {
    const row = await queryOne<{ id: number }>(db, 'SELECT id FROM dbo.bekleyen_faturalar WHERE form_id = @f AND dosya_ozeti = @h', {
      f: p.int(formId),
      h: p.ascii(hash, 64),
    });
    if (row === null) throw new Error('bekleyen fatura yok');
    return row.id;
  };

  describe('cost centre and organisation', () => {
    it("picks the owner's only active cost centre on create and checks a chosen one", async () => {
      const org = await makeOrganization(db, '1000', 'Şenpiliç Gıda');
      const mm1 = await makeCostCenter(db, '11033106');
      const mm2 = await makeCostCenter(db, '12043106', 'Satış');
      const off = await makeCostCenter(db, '13000000', null, false);
      const foreign = await makeCostCenter(db, '99999999');
      await assignDefinitions(db, owner.id, org, [mm1, off]);
      const d = await svc.create(owner, form(), false);
      expect(d.masrafMerkezi).toEqual({ id: mm1, kod: '11033106', aciklama: null, gosterim: '11033106', aktif: true });
      expect(d.organizasyon).toEqual({ id: org, kod: '1000', ad: 'Şenpiliç Gıda', aktif: true });
      expect(d.eksikAlanlar).toEqual([]);

      // With two active ones none is picked; a chosen one must be the owner's and active.
      await assignDefinitions(db, owner.id, org, [mm1, mm2, off]);
      expect((await svc.create(owner, form(), false)).masrafMerkezi).toBeNull();
      expect((await svc.create(owner, form({ masrafMerkeziId: mm2 }), false)).masrafMerkezi?.gosterim).toBe('12043106 – Satış');
      await fails(svc.create(owner, form({ masrafMerkeziId: foreign }), false), 400, 'gecersiz_istek', { masrafMerkeziId: 'Bu masraf merkezi size tanımlı değil.' });
      await fails(svc.create(owner, form({ masrafMerkeziId: off }), false), 400, 'gecersiz_istek', { masrafMerkeziId: 'Bu masraf merkezi pasif.' });
      await fails(svc.create(owner, form({ masrafMerkeziId: 999_999 }), false), 400, 'gecersiz_istek', { masrafMerkeziId: 'Bu masraf merkezi size tanımlı değil.' });

      // The lists show them too, newest first.
      const list = await svc.list(owner, { kapsam: 'benim', sayfa: 1, adet: 20 });
      expect(list.kayitlar.map((k) => k.masrafMerkezi?.id ?? null)).toEqual([mm2, null, mm1]);
      expect(list.kayitlar.map((k) => k.organizasyon?.kod)).toEqual(['1000', '1000', '1000']);
    });

    it('keeps a stored cost centre that became inactive or unassigned, but does not send with it', async () => {
      const mm1 = await makeCostCenter(db, '11033106');
      const mm2 = await makeCostCenter(db, '12043106');
      await assignDefinitions(db, owner.id, null, [mm1, mm2]);
      const d = await svc.create(owner, form({ tutar: 100, masrafMerkeziId: mm1 }), false);

      await assignDefinitions(db, owner.id, null, [mm2]);
      const kept = await svc.update(d.id, owner, { masrafMerkeziId: mm1, baslik: 'Yeni başlık' });
      expect(kept.masrafMerkezi?.id).toBe(mm1);
      expect(kept.eksikAlanlar).toEqual(['masrafMerkezi']);
      const gone = { masrafMerkeziId: 'Seçili masraf merkezi size artık tanımlı değil; başka birini seçin.' };
      await fails(svc.submit(d.id, owner), 409, 'alan_eksik', gone);

      await assignDefinitions(db, owner.id, null, [mm1, mm2]);
      await execute(db, 'UPDATE dbo.masraf_merkezleri SET aktif = 0 WHERE id = @m', { m: p.int(mm1) });
      expect((await svc.update(d.id, owner, { masrafMerkeziId: mm1 })).masrafMerkezi).toMatchObject({ id: mm1, aktif: false });
      await fails(svc.submit(d.id, owner), 409, 'alan_eksik', gone);

      const moved = await svc.update(d.id, owner, { masrafMerkeziId: mm2 });
      expect(notes(moved).at(-1)).toBe('Masraf merkezi: 11033106 → 12043106.');
      expect(moved.eksikAlanlar).toEqual([]);
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
      // Once sent, the owner's assignment no longer matters to the detail.
      await assignDefinitions(db, owner.id, null, []);
      expect((await svc.detail(d.id, owner)).eksikAlanlar).toEqual([]);
    });

    it('requires a cost centre when marked or by a rule, and never while the field is inactive', async () => {
      const mm1 = await makeCostCenter(db, '11033106');
      await assignDefinitions(db, owner.id, null, [mm1]);
      const d = await svc.create(owner, form({ tutar: 100, masrafMerkeziId: null }), false);
      expect(d.masrafMerkezi).toBeNull();
      expect(d.eksikAlanlar).toEqual([]);

      await rule('kategori', 1, ['masrafMerkezi']);
      expect((await svc.detail(d.id, owner)).eksikAlanlar).toEqual(['masrafMerkezi']);
      await fails(svc.submit(d.id, owner), 409, 'alan_eksik', { masrafMerkeziId: 'Masraf merkezi seçilmeli.' });
      // Another category is not under the rule; marking the field required brings it back.
      expect((await svc.update(d.id, owner, { kategoriId: 2 })).eksikAlanlar).toEqual([]);
      await setField('masrafMerkezi', { zorunlu: true });
      expect((await svc.detail(d.id, owner)).eksikAlanlar).toEqual(['masrafMerkezi']);

      // Inactive: never required, a request cannot carry one, and a new form gets none.
      await setField('masrafMerkezi', { aktif: false });
      expect((await svc.detail(d.id, owner)).eksikAlanlar).toEqual([]);
      await fails(svc.update(d.id, owner, { masrafMerkeziId: mm1 }), 400, 'gecersiz_istek', { masrafMerkeziId: expect.any(String) });
      await fails(svc.update(d.id, owner, { masrafMerkeziId: null }), 400, 'gecersiz_istek', { masrafMerkeziId: expect.any(String) });
      expect((await svc.create(owner, form(), false)).masrafMerkezi).toBeNull();
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it("copies the owner's organisation on every save and on sending, and keeps it once sent", async () => {
      const first = await makeOrganization(db, '1000');
      const second = await makeOrganization(db, '2000', 'İkinci');
      await assignDefinitions(db, owner.id, first);
      const d = await svc.create(owner, form({ tutar: 100 }), false);
      expect(d.organizasyon?.id).toBe(first);
      await assignDefinitions(db, owner.id, second);
      expect((await svc.update(d.id, owner, {})).organizasyon).toEqual({ id: second, kod: '2000', ad: 'İkinci', aktif: true });
      await assignDefinitions(db, owner.id, first);
      expect((await svc.submit(d.id, owner)).organizasyon?.id).toBe(first);
      await assignDefinitions(db, owner.id, null);
      expect((await svc.detail(d.id, owner)).organizasyon?.id).toBe(first);
    });
  });

  describe('required receipt fields', () => {
    it('requires the targets of a category rule on every invoice (alan_eksik) and sends once they are filled', async () => {
      const tag = await makeOption(db, 'etiket', 'P34MHG325', 'P34MHG325-18036470');
      const project = await makeOption(db, 'projeKodu', 'PRJ-1');
      await rule('kategori', 4, ['etiket', 'projeKodu']);
      const i1 = await makeInvoice(db, owner.id);
      const i2 = await makeInvoice(db, owner.id);
      const d = await svc.create(owner, form({ kategoriId: 4, tutar: 3600, faturaIdler: [i1, i2], fisAlanlari: { [i1]: { etiket: tag } } }), false);
      expect(d.faturalar.map((f) => f.eksikAlanlar)).toEqual([['projeKodu'], ['etiket', 'projeKodu']]);
      expect(d.faturalar[0]?.alanlar).toEqual({ etiket: { deger: tag, gosterim: 'P34MHG325 – P34MHG325-18036470' } });
      expect(d.faturalar[1]?.alanlar).toEqual({});

      const err = await svc.submit(d.id, owner).catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 409,
        code: 'alan_eksik',
        message: '1. faturada eksik alan var: Proje Kodu. Eksik alanları doldurup yeniden gönderin.',
        details: {
          alanlar: {
            [`fisAlanlari.${i1}.projeKodu`]: 'Proje Kodu zorunlu.',
            [`fisAlanlari.${i2}.etiket`]: 'Etiket zorunlu.',
            [`fisAlanlari.${i2}.projeKodu`]: 'Proje Kodu zorunlu.',
          },
        },
      });
      // Under another category the rule does not apply.
      expect((await svc.update(d.id, owner, { kategoriId: 1 })).faturalar.map((f) => f.eksikAlanlar)).toEqual([[], []]);
      await svc.update(d.id, owner, { kategoriId: 4, fisAlanlari: { [i1]: { etiket: tag, projeKodu: project }, [i2]: { etiket: tag, projeKodu: project } } });
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('requires a header field on the receipts whose list value a rule names (fatura_eksik)', async () => {
      const invoiceType = await optionId(db, 'dokumanTipi', 'Fatura');
      const receiptType = await optionId(db, 'dokumanTipi', 'Fiş');
      await rule('dokumanTipi', invoiceType, ['saticiVergiNo']);
      const inv = await makeInvoice(db, owner.id, { saticiVergiNo: null });
      const d = await svc.create(owner, form({ tutar: 1800, faturaIdler: [inv], fisAlanlari: { [inv]: { dokumanTipi: invoiceType } } }), false);
      expect(d.faturalar[0]?.eksikAlanlar).toEqual(['saticiVergiNo']);
      const err = await svc.submit(d.id, owner).catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 409,
        code: 'fatura_eksik',
        message: 'Faturada eksik bilgi var: satıcı vergi no. Eksik alanları doldurup yeniden gönderin.',
        details: { alanlar: { [`faturalar.${inv}.saticiVergiNo`]: 'Bu alan okunamadı; doldurun.' } },
      });
      const asReceipt = await svc.update(d.id, owner, { fisAlanlari: { [inv]: { dokumanTipi: receiptType } } });
      expect(asReceipt.faturalar[0]?.eksikAlanlar).toEqual([]);
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('lets a form whose invoice has no seller go once the seller is no longer required', async () => {
      const inv = await makeInvoice(db, owner.id, { saticiUnvan: null });
      const d = await svc.create(owner, form({ tutar: 1800, satici: 'Elle yazılan', faturaIdler: [inv] }), false);
      expect(d.faturalar[0]?.eksikAlanlar).toEqual(['saticiUnvan']);
      await fails(svc.submit(d.id, owner), 409, 'fatura_eksik', { [`faturalar.${inv}.saticiUnvan`]: 'Bu alan okunamadı; doldurun.' });
      await setField('saticiUnvan', { zorunlu: false });
      expect((await svc.detail(d.id, owner)).faturalar[0]?.eksikAlanlar).toEqual([]);
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('never requires an inactive field and keeps its values hidden until it is active again', async () => {
      const tag = await makeOption(db, 'etiket', 'E1');
      const inv = await makeInvoice(db, owner.id);
      const d = await svc.create(owner, form({ tutar: 1800, faturaIdler: [inv], fisAlanlari: { [inv]: { etiket: tag, not: 'Not' } } }), false);
      await setField('etiket', { zorunlu: true, aktif: false });
      const hidden = await svc.detail(d.id, owner);
      expect(hidden.faturalar[0]?.alanlar).toEqual({ not: { deger: 'Not', gosterim: 'Not' } });
      expect(hidden.faturalar[0]?.eksikAlanlar).toEqual([]);
      await fails(svc.update(d.id, owner, { fisAlanlari: { [inv]: { etiket: tag } } }), 400, 'gecersiz_istek', {
        [`fisAlanlari.${inv}.etiket`]: 'Bu alan fişte kullanılmıyor.',
      });
      // Replacing the receipt's values clears the active fields and keeps the inactive one's.
      expect((await svc.update(d.id, owner, { fisAlanlari: { [inv]: {} } })).faturalar[0]?.alanlar).toEqual({});
      await setField('etiket', { aktif: true });
      const back = await svc.detail(d.id, owner);
      expect(back.faturalar[0]).toMatchObject({ alanlar: { etiket: { deger: tag, gosterim: 'E1' } }, eksikAlanlar: [] });
      expect((await svc.submit(d.id, owner)).durum).toBe('onayda');
    });

    it('reports alan_eksik when "okununca gönder" cannot send', async () => {
      await setField('etiket', { zorunlu: true });
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ tutar: 1800, bekleyenFaturalar: [hash], okununcaGonder: true }), false);
      expect(d.bekleyenFaturalar[0]?.eksikAlanlar).toEqual(['etiket']);
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: await readDone(owner, hash) });
      const after = await svc.detail(d.id, owner);
      expect(after.durum).toBe('taslak');
      expect(after.okununcaGonder).toBe(false);
      expect(notes(after).at(-1)).toBe('Okununca gönder: masraf onaya gönderilemedi. Faturada eksik alan var: Etiket. Eksik alanları doldurup yeniden gönderin.');
      const told = await query<{ tur: string; mesaj: string }>(db, 'SELECT tur, mesaj FROM dbo.bildirimler WHERE kullanici_id = @u ORDER BY id', { u: p.int(owner.id) });
      expect(told.at(-1)).toMatchObject({ tur: 'onaya_gonderilemedi', mesaj: expect.stringContaining('Etiket') });
    });
  });

  describe('values on receipts', () => {
    it('keeps the values of a file still being read and moves them to its invoice when it is read', async () => {
      const tag = await makeOption(db, 'etiket', 'E1');
      const hash = reading.sending(owner, 'fis.jpg');
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash], fisAlanlari: { [hash]: { etiket: tag, not: 'Araç yıkama' } } }), false);
      expect(d.bekleyenFaturalar[0]).toMatchObject({
        alanlar: { etiket: { deger: tag, gosterim: 'E1' }, not: { deger: 'Araç yıkama', gosterim: 'Araç yıkama' } },
        eksikAlanlar: [],
      });
      // Values made in the same request as the file are its first values, not a change.
      expect(notes(d)).toEqual([null, '1 fatura okunmayı bekliyor.']);

      await setField('projeKodu', { zorunlu: true });
      const changed = await svc.update(d.id, owner, { fisAlanlari: { [hash]: { etiket: tag } } });
      expect(changed.bekleyenFaturalar[0]).toMatchObject({ alanlar: { etiket: { deger: tag, gosterim: 'E1' } }, eksikAlanlar: ['projeKodu'] });
      expect(notes(changed).at(-1)).toBe('fis.jpg dosyasının alanları değişti: Not.');

      const kayit = await readDone(owner, hash);
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: kayit });
      const read = await svc.detail(d.id, owner);
      expect(read.faturaIdler).toEqual([kayit]);
      expect(read.faturalar[0]).toMatchObject({ alanlar: { etiket: { deger: tag, gosterim: 'E1' } }, eksikAlanlar: ['projeKodu'] });
      expect(await query(db, 'SELECT bekleyen_id FROM dbo.bekleyen_alan_degerleri')).toEqual([]);

      // A client that has not seen the read yet names the receipt by its file.
      const byHash = await svc.update(d.id, owner, { fisAlanlari: { [hash]: { etiket: tag, not: 'Yine' } } });
      expect(byHash.faturalar[0]?.alanlar.not).toEqual({ deger: 'Yine', gosterim: 'Yine' });
      expect(notes(byHash).at(-1)).toBe('1. faturanın alanları değişti: Not.');
      await fails(svc.update(d.id, owner, { fisAlanlari: { [kayit]: {}, [hash]: {} } }), 400, 'gecersiz_istek', {
        [`fisAlanlari.${hash}`]: 'Bu fiş istekte iki kez yazılmış.',
      });
    });

    it("keeps the invoice's own values when the read file is on the form already", async () => {
      const e1 = await makeOption(db, 'etiket', 'E1');
      const e2 = await makeOption(db, 'etiket', 'E2');
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash], fisAlanlari: { [hash]: { etiket: e1 } } }), false);
      const kayit = await readDone(owner, hash);
      // The client saw the read first and listed the invoice, with values of its own.
      await svc.update(d.id, owner, { faturaIdler: [kayit], fisAlanlari: { [kayit]: { etiket: e2 } } });
      await svc.settleWaiting(await waitingId(d.id, hash), { kayitId: kayit });
      const after = await svc.detail(d.id, owner);
      expect(after.bekleyenFaturalar).toEqual([]);
      expect(after.faturalar.map((f) => f.alanlar)).toEqual([{ etiket: { deger: e2, gosterim: 'E2' } }]);
    });

    it('keeps the values with a file whose read failed', async () => {
      const tag = await makeOption(db, 'etiket', 'E1');
      const hash = reading.sending(owner);
      const d = await svc.create(owner, form({ bekleyenFaturalar: [hash], fisAlanlari: { [hash]: { etiket: tag } } }), false);
      await svc.settleWaiting(await waitingId(d.id, hash), { hata: { kod: 'claude_failed', mesaj: 'Okunamadı.' } });
      expect((await svc.detail(d.id, owner)).bekleyenFaturalar[0]).toMatchObject({ durum: 'hata', alanlar: { etiket: { deger: tag, gosterim: 'E1' } } });
      // Taken off the form, its values go with it.
      await svc.update(d.id, owner, { bekleyenFaturalar: [] });
      expect(await query(db, 'SELECT bekleyen_id FROM dbo.bekleyen_alan_degerleri')).toEqual([]);
    });

    it('accepts an option that became inactive only as the value it already was', async () => {
      const e1 = await makeOption(db, 'etiket', 'E1');
      const e2 = await makeOption(db, 'etiket', 'E2', null, false);
      const cash = await optionId(db, 'odemeYontemi', 'Nakit');
      const inv = await makeInvoice(db, owner.id);
      const d = await svc.create(owner, form({ faturaIdler: [inv], fisAlanlari: { [inv]: { etiket: e1 } } }), false);
      await execute(db, 'UPDATE dbo.alan_secenekleri SET aktif = 0 WHERE id = @o', { o: p.int(e1) });
      const again = await svc.update(d.id, owner, { fisAlanlari: { [inv]: { etiket: e1, odemeYontemi: cash } } });
      expect(again.faturalar[0]?.alanlar).toEqual({ etiket: { deger: e1, gosterim: 'E1' }, odemeYontemi: { deger: cash, gosterim: 'Nakit' } });
      await fails(svc.update(d.id, owner, { fisAlanlari: { [inv]: { etiket: e2 } } }), 400, 'gecersiz_istek', {
        [`fisAlanlari.${inv}.etiket`]: 'Bu seçenek pasif; başka birini seçin.',
      });
      await fails(svc.update(d.id, owner, { fisAlanlari: { [inv]: { etiket: cash } } }), 400, 'gecersiz_istek', {
        [`fisAlanlari.${inv}.etiket`]: 'Bu seçenek bu alanın listesinde yok.',
      });
    });

    it('refuses receipts that are not on the form and values that do not fit their field', async () => {
      const inv = await makeInvoice(db, owner.id);
      const other = await makeInvoice(db, owner.id);
      const d = await svc.create(owner, form({ faturaIdler: [inv] }), false);
      const bad = (fisAlanlari: FormInput['fisAlanlari'], alan: string, mesaj: string): Promise<void> =>
        fails(svc.update(d.id, owner, { fisAlanlari }), 400, 'gecersiz_istek', { [alan]: mesaj });
      await bad({ [other]: {} }, `fisAlanlari.${other}`, 'Bu fiş formda yok.');
      await bad({ ['a'.repeat(64)]: {} }, `fisAlanlari.${'a'.repeat(64)}`, 'Bu fiş formda yok.');
      for (const key of ['kategori', 'masrafMerkezi', 'faturaNo', 'yok']) {
        await bad({ [inv]: { [key]: 1 } }, `fisAlanlari.${inv}.${key}`, 'Bu alan fişte kullanılmıyor.');
      }
      await bad({ [inv]: { vergiDairesi: 'x'.repeat(201) } }, `fisAlanlari.${inv}.vergiDairesi`, 'Vergi Dairesi en fazla 200 karakter olabilir.');
      await bad({ [inv]: { etiket: 'E1' } }, `fisAlanlari.${inv}.etiket`, 'Etiket için listeden bir seçenek seçin.');
      await bad({ [inv]: { not: 12 } }, `fisAlanlari.${inv}.not`, 'Not metin olmalıdır.');
      // A receipt joining the list in the same request may get values right away.
      const both = await svc.update(d.id, owner, { faturaIdler: [inv, other], fisAlanlari: { [other]: { not: '  Yeni  ' } } });
      expect(both.faturalar[1]?.alanlar).toEqual({ not: { deger: 'Yeni', gosterim: 'Yeni' } });
    });

    it('writes field changes into the same history line and drops the values of an invoice taken off', async () => {
      const mm = await makeCostCenter(db, '11033106');
      await assignDefinitions(db, owner.id, null, [mm]);
      const tag = await makeOption(db, 'etiket', 'E1');
      const i1 = await makeInvoice(db, owner.id);
      const i2 = await makeInvoice(db, owner.id);
      const d = await svc.create(owner, form({ faturaIdler: [i1, i2], masrafMerkeziId: null }), false);
      const changed = await svc.update(d.id, owner, {
        faturaIdler: [i2, i1],
        masrafMerkeziId: mm,
        fisAlanlari: { [i1]: { etiket: tag, not: 'x' }, [i2]: { vergiDairesi: 'Kadıköy' } },
      });
      expect(notes(changed).at(-1)).toBe(
        'Faturaların sırası değişti. Masraf merkezi: yok → 11033106. 1. faturanın alanları değişti: Vergi Dairesi. 2. faturanın alanları değişti: Etiket, Not.',
      );
      expect(changed.gecmis.length).toBe(d.gecmis.length + 1);

      // The same values again change nothing; the values followed their invoices through the new order.
      const same = await svc.update(d.id, owner, { fisAlanlari: { [i1]: { etiket: tag, not: 'x' } } });
      expect(notes(same).at(-1)).toBeNull();
      expect(same.faturalar.map((f) => Object.keys(f.alanlar))).toEqual([['vergiDairesi'], ['etiket', 'not']]);

      // Taken off the form, an invoice's values go; added again, it starts empty.
      await svc.update(d.id, owner, { faturaIdler: [i2] });
      expect(await query(db, 'SELECT DISTINCT kayit_id FROM dbo.fis_alan_degerleri WHERE form_id = @f', { f: p.int(d.id) })).toEqual([{ kayit_id: i2 }]);
      expect((await svc.update(d.id, owner, { faturaIdler: [i2, i1] })).faturalar[1]?.alanlar).toEqual({});
    });
  });

  describe('approval document and export', () => {
    it("prints the organisation, the cost centre and each invoice's receipt fields", async () => {
      const org = await makeOrganization(db, '1000', 'Şenpiliç Gıda');
      const mm = await makeCostCenter(db, '11033106', 'Merkez');
      await assignDefinitions(db, owner.id, org, [mm]);
      const card = await optionId(db, 'odemeYontemi', 'Kredi Kartı');
      const i1 = await makeInvoice(db, owner.id, { faturaNo: 'F-1' });
      const i2 = await makeInvoice(db, owner.id, { faturaNo: 'F-2' });
      const d = await svc.create(owner, form({ tutar: 3600, faturaIdler: [i1, i2], fisAlanlari: { [i1]: { not: 'Araç yıkama', odemeYontemi: card } } }), false);

      vi.mocked(renderApprovalPdf).mockClear();
      const pdf = await svc.pdfForMail(d.id);
      expect(pdf?.subarray(0, 5).toString()).toBe('%PDF-');
      const data = vi.mocked(renderApprovalPdf).mock.calls[0]?.[0] as PdfData;
      expect(data.form).toMatchObject({ organizasyon: '1000 – Şenpiliç Gıda', masrafMerkezi: '11033106 – Merkez' });
      expect(data.faturalar.map((x) => x.alanlar)).toEqual([
        [
          { ad: 'Ödeme Yöntemi', gosterim: 'Kredi Kartı' },
          { ad: 'Not', gosterim: 'Araç yıkama' },
        ],
        [],
      ]);

      const accountant = await makeUser(db, { rol: 'muhasebe' });
      await svc.create(owner, form({ masrafMerkeziId: null }), false);
      await assignDefinitions(db, owner.id, null, [mm]);
      await svc.create(owner, form({ masrafMerkeziId: null, masrafTarihi: '2025-06-16' }), false);
      const lines = toCsv(await svc.exportRows(accountant, {})).split('\r\n');
      expect(lines[0]?.endsWith(';Organizasyon;Masraf Merkezi')).toBe(true);
      expect(lines.slice(1, -1).map((l) => l.split(';').slice(-2))).toEqual([
        ['1000 – Şenpiliç Gıda', '11033106 – Merkez'],
        ['1000 – Şenpiliç Gıda', ''],
        ['', ''],
      ]);
    });
  });
});
