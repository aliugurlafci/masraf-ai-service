import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanFileName, createInvoiceStorage, newRecordId } from '../src/storage.ts';
import { sampleInvoice, sampleOlcum } from './helpers.ts';

describe('storage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fatura-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves one dated JSON file per invoice and reads it back', async () => {
    const storage = createInvoiceStorage(dir);
    const now = new Date('2026-11-05T09:08:07Z');
    const record = await storage.save({ dosyaAdi: 'C:\\Users\\x\\Ekim faturası.pdf', sonuc: sampleInvoice() }, now);

    expect(record.id).toMatch(/^20261105-090807-[a-f0-9]{8}$/);
    expect(record.dosyaAdi).toBe('Ekim faturası.pdf');
    const onDisk = JSON.parse(await readFile(join(dir, '2026-11-05', `${record.id}.json`), 'utf8'));
    expect(onDisk).toEqual({ ...record, olusturulma: '2026-11-05T09:08:07.000Z' });
    expect(await storage.get(record.id)).toEqual(record);
  });

  it('lists newest first with a short summary', async () => {
    const storage = createInvoiceStorage(dir);
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
    expect(await storage.list(1)).toHaveLength(1);
  });

  it('returns an empty list before anything is saved', async () => {
    expect(await createInvoiceStorage(join(dir, 'yok')).list()).toEqual([]);
  });

  it('skips corrupt files instead of failing the list', async () => {
    const storage = createInvoiceStorage(dir);
    const good = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice() }, new Date('2026-11-05T10:00:00Z'));
    await writeFile(join(dir, '2026-11-05', '20261105-235959-deadbeef.json'), '{bozuk');
    await writeFile(join(dir, '2026-11-05', 'notlar.json'), '{}');
    expect((await storage.list()).map((r) => r.id)).toEqual([good.id]);
  });

  it.each(['../../etc/passwd', '20261105-000000-DEADBEEF', '2026-11-05', '', '20261105-000000-deadbeef/../x'])(
    'rejects invalid id %j',
    async (id) => {
      expect(await createInvoiceStorage(dir).get(id)).toBeNull();
    },
  );

  describe('findByHash', () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);

    it('finds the record made from the same file, including after a restart', async () => {
      const first = createInvoiceStorage(dir);
      const rec = await first.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-05T10:00:00Z'));
      expect(rec.dosyaOzeti).toBe(hashA);
      expect((await first.findByHash(hashA))?.id).toBe(rec.id);
      expect(await first.findByHash(hashB)).toBeNull();

      const restarted = createInvoiceStorage(dir);
      expect((await restarted.findByHash(hashA))?.id).toBe(rec.id);
    });

    it('prefers the newest record and keeps the index current after saves', async () => {
      const storage = createInvoiceStorage(dir);
      await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-04T10:00:00Z'));
      expect(await storage.findByHash(hashB)).toBeNull(); // builds the index
      const newer = await storage.save({ dosyaAdi: 'a2.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-05T10:00:00Z'));
      expect((await storage.findByHash(hashA))?.id).toBe(newer.id);
      expect((await createInvoiceStorage(dir).findByHash(hashA))?.id).toBe(newer.id);
    });

    it('forgets records whose file was deleted', async () => {
      const storage = createInvoiceStorage(dir);
      const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), dosyaOzeti: hashA }, new Date('2026-11-05T10:00:00Z'));
      await rm(join(dir, '2026-11-05', `${rec.id}.json`));
      expect(await storage.findByHash(hashA)).toBeNull();
    });

    it('still reads records saved before hashes existed', async () => {
      const storage = createInvoiceStorage(dir);
      const old = await storage.save({ dosyaAdi: 'eski.pdf', sonuc: sampleInvoice() }, new Date('2026-11-05T10:00:00Z'));
      expect(old).not.toHaveProperty('dosyaOzeti');
      expect(old).not.toHaveProperty('olcum');
      expect(await storage.get(old.id)).toEqual(old);
      expect(await storage.findByHash(hashA)).toBeNull();
      expect(await storage.findByHash('../../x')).toBeNull();
    });
  });

  it('stores the measurements of the Claude run', async () => {
    const storage = createInvoiceStorage(dir);
    const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice(), olcum: sampleOlcum() });
    expect((await storage.get(rec.id))?.olcum).toEqual(sampleOlcum());
  });

  it('drops malformed measurements instead of hiding the record', async () => {
    const storage = createInvoiceStorage(dir);
    const rec = await storage.save({ dosyaAdi: 'a.pdf', sonuc: sampleInvoice() }, new Date('2026-11-05T10:00:00Z'));
    const file = join(dir, '2026-11-05', `${rec.id}.json`);
    await writeFile(file, JSON.stringify({ ...rec, olcum: { sureMs: 'hızlı' } }));
    const back = await storage.get(rec.id);
    expect(back?.sonuc).toEqual(sampleInvoice());
    expect(back?.olcum).toBeUndefined();
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
