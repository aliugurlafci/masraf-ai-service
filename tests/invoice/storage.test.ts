import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute, p, queryOne, type Db } from '../../src/db/sql.ts';
import { cleanFileName, createInvoiceStorage, newRecordId, type InvoiceStorage } from '../../src/invoice/storage.ts';
import { closeTestDb, makeUser, resetDb, testDb } from '../db.ts';
import { PDF_BYTES, PNG_BYTES, sampleInvoice, sampleOlcum } from '../helpers.ts';

describe('invoice storage (SQL Server)', () => {
  let db: Db;
  let storage: InvoiceStorage;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
    storage = createInvoiceStorage(db);
  });

  it('saves one row per invoice and reads it back', async () => {
    const now = new Date('2026-11-05T09:08:07Z');
    const record = await storage.save({ dosyaAdi: 'C:\\Users\\x\\Ekim faturası.pdf', sonuc: sampleInvoice() }, now);

    expect(record.id).toMatch(/^20261105-090807-[a-f0-9]{8}$/);
    expect(record.dosyaAdi).toBe('Ekim faturası.pdf');
    expect(record.olusturulma).toBe('2026-11-05T09:08:07.000Z');
    const row = await queryOne<{ sonuc: string; fatura_no: string; genel_toplam: number }>(
      db,
      'SELECT sonuc, fatura_no, genel_toplam FROM dbo.fatura_kayitlari WHERE id = @id',
      { id: p.ascii(record.id, 24) },
    );
    expect(JSON.parse(row?.sonuc ?? 'null')).toEqual(sampleInvoice());
    expect(row).toMatchObject({ fatura_no: 'ABC2026000000123', genel_toplam: 1800 });
    expect(await storage.get(record.id)).toEqual(record);
  });

  it('lists newest first with a short summary', async () => {
    const older = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice({ faturaNo: 'A1' }) }, new Date('2026-11-04T10:00:00Z'));
    const newer = await storage.save({ dosyaAdi: 'b.png', sonuc: sampleInvoice({ faturaNo: 'B2' }) }, new Date('2026-11-05T10:00:00Z'));

    const list = await storage.list();
    expect(list.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(list[0]).toEqual({
      id: newer.id,
      dosyaAdi: 'b.png',
      olusturulma: '2026-11-05T10:00:00.000Z',
      faturaNo: 'B2',
      saticiUnvan: 'Örnek Yazılım A.Ş.',
      genelToplam: 1800,
      paraBirimi: 'TRY',
    });
    expect(await storage.list({ limit: 1 })).toHaveLength(1);
  });

  it('returns an empty list before anything is saved', async () => {
    expect(await storage.list()).toEqual([]);
  });

  it('treats a row whose JSON no longer fits the schema as missing, without breaking other reads', async () => {
    const good = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice() }, new Date('2026-11-05T10:00:00Z'));
    await execute(db, `INSERT INTO dbo.fatura_kayitlari (id, dosya_adi, olusturma, sonuc) VALUES ('20261105-235959-deadbeef', N'bozuk.pdf', SYSUTCDATETIME(), N'{"x":1}')`);
    expect(await storage.get('20261105-235959-deadbeef')).toBeNull();
    expect(await storage.get(good.id)).toEqual(good);
  });

  it('keeps misread values out of the list columns instead of failing the save', async () => {
    const odd = sampleInvoice({ faturaTarihi: '2026-02-30', genelToplam: 4e30 });
    const rec = await storage.save({ dosyaAdi: 'garip.pdf', sonuc: odd });
    expect((await storage.get(rec.id))?.sonuc).toEqual(odd);
    const row = await queryOne<{ fatura_tarihi: Date | null }>(db, 'SELECT fatura_tarihi FROM dbo.fatura_kayitlari WHERE id = @id', {
      id: p.ascii(rec.id, 24),
    });
    expect(row?.fatura_tarihi).toBeNull();
  });

  it.each(['../../etc/passwd', '20261105-000000-DEADBEEF', '2026-11-05', '', "20261105-000000-deadbeef' OR 1=1 --"])(
    'rejects invalid id %j',
    async (id) => {
      expect(await storage.get(id)).toBeNull();
      expect(await storage.getFile(id)).toBeNull();
    },
  );

  describe('findByHash', () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);

    it('finds the record made from the same file, also from a new storage object', async () => {
      const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-05T10:00:00Z'));
      expect(rec.dosyaOzeti).toBe(hashA);
      expect((await storage.findByHash(hashA))?.id).toBe(rec.id);
      expect(await storage.findByHash(hashB)).toBeNull();
      expect((await createInvoiceStorage(db).findByHash(hashA))?.id).toBe(rec.id);
    });

    it('prefers the newest record', async () => {
      await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-04T10:00:00Z'));
      const newer = await storage.save({ dosyaAdi: 'a2.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-05T10:00:00Z'));
      expect((await storage.findByHash(hashA))?.id).toBe(newer.id);
    });

    it('forgets records that were deleted', async () => {
      const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA });
      await execute(db, 'DELETE FROM dbo.fatura_kayitlari WHERE id = @id', { id: p.ascii(rec.id, 24) });
      expect(await storage.findByHash(hashA)).toBeNull();
    });

    it('still reads records saved without a hash or measurements', async () => {
      const old = await storage.save({ dosyaAdi: 'eski.pdf', sonuc: sampleInvoice() }, new Date('2026-11-05T10:00:00Z'));
      expect(old).not.toHaveProperty('dosyaOzeti');
      expect(old).not.toHaveProperty('olcum');
      expect(await storage.get(old.id)).toEqual(old);
      expect(await storage.findByHash(hashA)).toBeNull();
      expect(await storage.findByHash('../../x')).toBeNull();
    });
  });

  it('stores the measurements of the Claude run', async () => {
    const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), olcum: sampleOlcum() });
    expect((await storage.get(rec.id))?.olcum).toEqual(sampleOlcum());
  });

  it('drops malformed measurements instead of hiding the record', async () => {
    const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice() });
    await execute(db, `UPDATE dbo.fatura_kayitlari SET olcum = N'{"sureMs":"hızlı"}' WHERE id = @id`, { id: p.ascii(rec.id, 24) });
    const back = await storage.get(rec.id);
    expect(back?.sonuc).toEqual(sampleInvoice());
    expect(back?.olcum).toBeUndefined();
  });

  describe('files and uploads', () => {
    it('keeps the original file', async () => {
      const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosya: { icerik: PDF_BYTES, mime: 'application/pdf' } });
      expect(await storage.getFile(rec.id)).toEqual({ icerik: PDF_BYTES, mime: 'application/pdf' });
    });

    it('adds a missing file from a later upload but never replaces one', async () => {
      const user = await makeUser(db);
      const rec = await storage.save({ dosyaAdi: 'eski.pdf', sonuc: sampleInvoice() });
      expect(await storage.getFile(rec.id)).toBeNull();
      await storage.addUpload({ kayitId: rec.id, kullaniciId: user.id, dosyaAdi: 'a.pdf', dosya: { icerik: PDF_BYTES, mime: 'application/pdf' } });
      await storage.addUpload({ kayitId: rec.id, kullaniciId: user.id, dosyaAdi: 'b.png', dosya: { icerik: PNG_BYTES, mime: 'image/png' } });
      expect(await storage.getFile(rec.id)).toEqual({ icerik: PDF_BYTES, mime: 'application/pdf' });
    });

    it("lists a user's own uploads, newest upload first", async () => {
      const ali = await makeUser(db);
      const ayse = await makeUser(db);
      const a = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice({ faturaNo: 'A' }) }, new Date('2026-11-01T10:00:00Z'));
      const b = await storage.save({ dosyaAdi: 'b.pdf', sonuc: sampleInvoice({ faturaNo: 'B' }) }, new Date('2026-11-02T10:00:00Z'));
      await storage.addUpload({ kayitId: b.id, kullaniciId: ali.id, dosyaAdi: 'b.pdf' });
      await new Promise((r) => setTimeout(r, 20));
      await storage.addUpload({ kayitId: a.id, kullaniciId: ali.id, dosyaAdi: 'a.pdf' });
      await storage.addUpload({ kayitId: b.id, kullaniciId: ayse.id, dosyaAdi: 'b.pdf' });

      expect((await storage.list({ kullaniciId: ali.id })).map((r) => r.faturaNo)).toEqual(['A', 'B']);
      expect((await storage.list({ kullaniciId: ayse.id })).map((r) => r.faturaNo)).toEqual(['B']);
    });

    it('lets the uploader, accounting and administrators read an invoice, nobody else', async () => {
      const uploader = await makeUser(db);
      const other = await makeUser(db);
      const muhasebe = await makeUser(db, { rol: 'muhasebe' });
      const yonetici = await makeUser(db, { rol: 'yonetici' });
      const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice() });
      await storage.addUpload({ kayitId: rec.id, kullaniciId: uploader.id, dosyaAdi: 'a.pdf' });

      expect(await storage.canRead(rec.id, uploader)).toBe(true);
      expect(await storage.canRead(rec.id, other)).toBe(false);
      expect(await storage.canRead(rec.id, muhasebe)).toBe(true);
      expect(await storage.canRead(rec.id, yonetici)).toBe(true);
      expect(await storage.canRead('20261105-000000-deadbeef', yonetici)).toBe(false);
    });
  });

  it('generates unique ids', () => {
    const now = new Date();
    expect(newRecordId(now)).not.toBe(newRecordId(now));
  });

  it.each([
    ['/tmp/a/b/fatura.pdf', 'fatura.pdf'],
    ['..\\..\\x.png', 'x.png'],
    ['a\u0000b\nc.pdf', 'abc.pdf'],
    ['', 'fatura'],
    [undefined, 'fatura'],
    ['x'.repeat(300), 'x'.repeat(200)],
  ])('cleans file name %j', (input, expected) => {
    expect(cleanFileName(input)).toBe(expected);
  });
});
