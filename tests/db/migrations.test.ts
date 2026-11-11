// The schema file on an empty database: what it builds, the rules the schema itself enforces, and a
// database built from migration files that no longer exist (merged or renamed). The tests share one
// database and run in order.
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseError, loadMigrations, migrate } from '../../src/db/database.ts';
import { loadDbConfig } from '../../src/config.ts';
import { execute, p, poolConfig, query, queryOne, type Db } from '../../src/db/sql.ts';
import { closeTestDb, testDb } from '../db.ts';

describe('migrations', () => {
  let main: Db;
  let db: Db;
  const name = `masraf_goc_${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'}_${Date.now()}`;

  beforeAll(async () => {
    main = await testDb();
    await execute(main, `CREATE DATABASE [${name}]`);
    // testDb() has loaded .env, so the same settings reach the new database.
    db = await new sql.ConnectionPool(poolConfig(loadDbConfig(process.env), name)).connect();
  });

  afterAll(async () => {
    await db?.close();
    await execute(main, `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}];`).catch(() => {});
    await closeTestDb();
  });

  const addUser = async (eposta: string): Promise<number> => {
    const row = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.kullanicilar (eposta, ad_soyad, rol, sifre_ozeti) OUTPUT inserted.id VALUES (@e, N'Ad Soyad', 'yonetici', 'x')`,
      { e: p.str(eposta, 254) },
    );
    return row?.id ?? 0;
  };

  it('builds the schema from its files, once, with the default flow and the categories', async () => {
    const all = await loadMigrations();
    expect(all.map((m) => m.name)).toEqual(['001_baslangic.sql', '002_entegrasyonlar.sql']);
    expect(await migrate(db, all)).toEqual(['001_baslangic.sql', '002_entegrasyonlar.sql']);
    expect(await migrate(db, all)).toEqual([]);

    // The default flow is a chain.
    expect(await query(db, 'SELECT ad, varsayilan, strateji FROM dbo.onay_akislari')).toEqual([{ ad: 'Genel', varsayilan: true, strateji: 'zincir' }]);
    const categories = await query<{ ad: string }>(db, 'SELECT ad FROM dbo.masraf_kategorileri ORDER BY sira');
    expect(categories.map((c) => c.ad)).toEqual(['Yemek', 'Ulaşım', 'Konaklama', 'Akaryakıt', 'Ofis malzemesi', 'Temsil ve ağırlama', 'Eğitim', 'İletişim', 'Diğer']);
    // Invoices hang off the form through form_faturalari only.
    const column = await queryOne(db, `SELECT 1 AS x FROM sys.columns WHERE object_id = OBJECT_ID('dbo.masraf_formlari') AND name = 'fatura_kayit_id'`);
    expect(column).toBeNull();

    // A flow step has one approval limit, no amount range; a form's approval rows keep the band they were sent with.
    const columns = async (table: string): Promise<string[]> =>
      (await query<{ name: string }>(db, 'SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t) ORDER BY column_id', { t: p.str(table, 128) })).map(
        (c) => c.name,
      );
    expect(await columns('dbo.onay_adimlari')).toEqual(['id', 'akis_id', 'sira', 'onayci_id', 'onay_limiti']);
    expect(await columns('dbo.form_onaylari')).toEqual(expect.arrayContaining(['alt_limit', 'ust_limit', 'son_hatirlatma']));
    const index = await queryOne(db, `SELECT 1 AS x FROM sys.indexes WHERE name = 'ix_onay_adimlari_onayci' AND object_id = OBJECT_ID('dbo.onay_adimlari')`);
    expect(index).toEqual({ x: 1 });
  });

  it('keeps one default flow, unique names, order and approver unique within a flow, positive limits and a known strategy', async () => {
    const [a, b] = [await addUser('a@firma.test'), await addUser('b@firma.test')];
    await expect(execute(db, `INSERT INTO dbo.onay_akislari (ad, varsayilan) VALUES (N'İkinci', 1)`)).rejects.toMatchObject({ number: 2601 });
    await expect(execute(db, `INSERT INTO dbo.onay_akislari (ad) VALUES (N'GENEL')`)).rejects.toMatchObject({ number: 2601 });

    const newFlow = async (ad: string): Promise<{ id: number; strateji: string }> =>
      (await queryOne<{ id: number; strateji: string }>(db, 'INSERT INTO dbo.onay_akislari (ad) OUTPUT inserted.id, inserted.strateji VALUES (@ad)', {
        ad: p.str(ad, 80),
      })) ?? { id: 0, strateji: '' };
    const satis = await newFlow('Satış');
    const destek = await newFlow('Destek');
    // A flow is a chain unless it says otherwise.
    expect(satis.strateji).toBe('zincir');
    const step = (f: number, sira: number, onayci: number, limit: number | null = null) =>
      execute(db, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, onay_limiti) VALUES (@f, @s, @o, @l)', {
        f: p.int(f),
        s: p.int(sira),
        o: p.int(onayci),
        l: p.money(limit),
      });
    await step(satis.id, 1, a, 1000);
    // The same approver and order in another flow are fine.
    await step(destek.id, 1, a);
    await expect(step(satis.id, 1, b)).rejects.toMatchObject({ number: 2601 });
    await expect(step(satis.id, 2, a)).rejects.toMatchObject({ number: 2601 });

    // A limit is above zero; NULL is no limit. The strategy is 'zincir' or 'tek'.
    await expect(step(satis.id, 2, b, 0)).rejects.toMatchObject({ number: 547 });
    await expect(step(satis.id, 2, b, -1)).rejects.toMatchObject({ number: 547 });
    await step(satis.id, 2, b, 0.01);
    const strategy = (value: string) => execute(db, 'UPDATE dbo.onay_akislari SET strateji = @st WHERE id = @f', { st: p.ascii(value, 8), f: p.int(satis.id) });
    await expect(strategy('hepsi')).rejects.toMatchObject({ number: 547 });
    await expect(strategy('')).rejects.toMatchObject({ number: 547 });
    await strategy('tek');
    await expect(execute(db, 'UPDATE dbo.onay_akislari SET strateji = NULL WHERE id = @f', { f: p.int(destek.id) })).rejects.toMatchObject({ number: 515 });

    // A user's flow must exist; a flow goes with its steps.
    await expect(execute(db, 'UPDATE dbo.kullanicilar SET onay_akisi_id = 999999 WHERE id = @a', { a: p.int(a) })).rejects.toMatchObject({ number: 547 });
    await execute(db, 'DELETE FROM dbo.onay_akislari WHERE id = @f', { f: p.int(satis.id) });
    expect(await query(db, 'SELECT akis_id FROM dbo.onay_adimlari WHERE akis_id IN (@s, @d)', { s: p.int(satis.id), d: p.int(destek.id) })).toEqual([
      { akis_id: destek.id },
    ]);
  });

  it('keeps an invoice on one live form and once per form, and a positive equivalent', async () => {
    const me = p.int(await addUser('fatura@firma.test'));
    for (const id of ['20260101-000000-aaaaaaaa', '20260101-000000-bbbbbbbb']) {
      await execute(db, `INSERT INTO dbo.fatura_kayitlari (id, dosya_adi, olusturma, sonuc) VALUES (@id, N'f.pdf', SYSUTCDATETIME(), N'{}')`, { id: p.ascii(id, 24) });
    }
    const addForm = async (durum: string): Promise<number> => {
      const row = await queryOne<{ id: number }>(
        db,
        `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, tutar, para_birimi, yerel_tutar, durum)
         OUTPUT inserted.id
         VALUES (@me, N'Masraf', (SELECT TOP (1) id FROM dbo.masraf_kategorileri), '2026-01-01', 10, 'TRY', 10, @d)`,
        { me, d: p.ascii(durum, 16) },
      );
      return row?.id ?? 0;
    };
    const link = (form: number, invoice: string, sira: number, aktif = 1, karsilik: number | null = null) =>
      execute(db, 'INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira, aktif, yerel_karsilik) VALUES (@f, @k, @s, @a, @y)', {
        f: p.int(form),
        k: p.ascii(invoice, 24),
        s: p.int(sira),
        a: p.int(aktif),
        y: p.money(karsilik),
      });
    const [cancelled, live, other] = [await addForm('iptal'), await addForm('onayda'), await addForm('taslak')];

    // A cancelled form's link does not hold the invoice.
    await link(cancelled, '20260101-000000-aaaaaaaa', 1, 0);
    await link(live, '20260101-000000-aaaaaaaa', 1, 1, 12.5);
    await expect(link(other, '20260101-000000-aaaaaaaa', 1)).rejects.toMatchObject({ number: 2601 });
    await link(other, '20260101-000000-bbbbbbbb', 1);
    await expect(link(other, '20260101-000000-bbbbbbbb', 2, 0)).rejects.toMatchObject({ number: 2627 });
    await expect(link(cancelled, '20260101-000000-bbbbbbbb', 1, 0)).rejects.toMatchObject({ number: 2601 });
    await expect(link(cancelled, '20260101-000000-bbbbbbbb', 0, 0)).rejects.toMatchObject({ number: 547 });
    await expect(execute(db, 'UPDATE dbo.form_faturalari SET yerel_karsilik = 0 WHERE form_id = @f', { f: p.int(live) })).rejects.toMatchObject({ number: 547 });

    // Deleting a form takes its links with it.
    await execute(db, 'DELETE FROM dbo.masraf_formlari WHERE id = @f', { f: p.int(other) });
    const links = await query<{ form_id: number; aktif: boolean; yerel_karsilik: number | null }>(
      db,
      'SELECT form_id, aktif, yerel_karsilik FROM dbo.form_faturalari ORDER BY form_id',
    );
    expect(links).toEqual([
      { form_id: cancelled, aktif: false, yerel_karsilik: null },
      { form_id: live, aktif: true, yerel_karsilik: 12.5 },
    ]);
  });

  it('keeps invoice corrections JSON only, and the duplicate key exact and unenforced', async () => {
    // Links start without a correction or a key.
    const links = await query<{ duzeltme: string | null; mukerrer_anahtari: string | null }>(db, 'SELECT duzeltme, mukerrer_anahtari FROM dbo.form_faturalari');
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.duzeltme === null && l.mukerrer_anahtari === null)).toBe(true);

    await expect(execute(db, `UPDATE dbo.form_faturalari SET duzeltme = N'{bozuk'`)).rejects.toMatchObject({ number: 547 });
    await execute(db, `UPDATE dbo.form_faturalari SET duzeltme = N'{"fatura":{},"kalemler":[]}'`);
    // Two live links may share a key (drafts); the application refuses to send them.
    const live = await execute(db, `UPDATE dbo.form_faturalari SET mukerrer_anahtari = N'V|1|A' WHERE aktif = 1`);
    expect(live).toBeGreaterThan(0);
    const index = await queryOne<{ is_unique: boolean; has_filter: boolean; filter_definition: string }>(
      db,
      `SELECT is_unique, has_filter, filter_definition FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.form_faturalari') AND name = 'ix_form_faturalari_mukerrer'`,
    );
    expect(index).toMatchObject({ is_unique: false, has_filter: true });
    expect(index?.filter_definition).toContain('[aktif]=(1)');
    // Keys compare exactly: no case or Turkish dotted/dotless I folding.
    const collation = await queryOne<{ collation_name: string }>(
      db,
      `SELECT collation_name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.form_faturalari') AND name = 'mukerrer_anahtari'`,
    );
    expect(collation?.collation_name).toBe('Latin1_General_100_BIN2');
  });

  it('keeps notifications, the mail box, the mail preference and reminder times, with their checks', async () => {
    const user = await addUser('bildirim@firma.test');
    expect(await queryOne(db, 'SELECT mail_bildirim FROM dbo.kullanicilar WHERE id = @u', { u: p.int(user) })).toEqual({ mail_bildirim: true });
    expect(await queryOne(db, `SELECT COUNT(*) AS n FROM dbo.form_onaylari WHERE son_hatirlatma IS NOT NULL`)).toEqual({ n: 0 });

    const notification = (tur: string) =>
      execute(db, `INSERT INTO dbo.bildirimler (kullanici_id, tur, baslik, mesaj) VALUES (@u, @t, N'B', N'M')`, { u: p.int(user), t: p.ascii(tur, 20) });
    await notification('onay_bekliyor');
    await notification('odeme_bekliyor');
    await expect(notification('bilinmeyen')).rejects.toMatchObject({ number: 547 });
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.bildirimler WHERE okunma IS NULL')).toEqual({ n: 2 });

    const mail = (durum: string, ek: string | null = null) =>
      execute(db, `INSERT INTO dbo.eposta_kutusu (adres, konu, metin, html, durum, ek_turu) VALUES (N'a@b.test', N'K', N'M', N'H', @d, @e)`, {
        d: p.ascii(durum, 12),
        e: p.ascii(ek, 16),
      });
    for (const durum of ['bekliyor', 'gonderildi', 'hata', 'atlandi']) await mail(durum);
    await expect(mail('gitti')).rejects.toMatchObject({ number: 547 });
    await expect(mail('bekliyor', 'fatura')).rejects.toMatchObject({ number: 547 });
    // The approval document belongs to a form.
    await expect(mail('bekliyor', 'masraf_pdf')).rejects.toMatchObject({ number: 547 });
  });

  it("keeps the form title a notification was written with, and deletes a form's notifications with it", async () => {
    const owner = await addUser('baslik@firma.test');
    const form = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, tutar, para_birimi, yerel_tutar, durum)
       OUTPUT inserted.id VALUES (@u, N'Eski başlık', (SELECT MIN(id) FROM dbo.masraf_kategorileri), '2026-01-01', 10, 'TRY', 10, 'onayda')`,
      { u: p.int(owner) },
    );
    const f = p.int(form?.id ?? 0);
    await execute(db, `INSERT INTO dbo.bildirimler (kullanici_id, tur, form_id, form_baslik, baslik, mesaj) VALUES (@u, 'odendi', @f, N'Eski başlık', N'B', N'M')`, {
      u: p.int(owner),
      f,
    });
    await execute(db, `UPDATE dbo.masraf_formlari SET baslik = N'Yeni başlık' WHERE id = @f`, { f });
    expect(await queryOne(db, 'SELECT form_baslik FROM dbo.bildirimler WHERE form_id = @f', { f })).toEqual({ form_baslik: 'Eski başlık' });
    await execute(db, 'DELETE FROM dbo.masraf_formlari WHERE id = @f', { f });
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.bildirimler WHERE form_id = @f', { f })).toEqual({ n: 0 });
  });

  it('lets only a draft leave its amount empty, and keeps files waiting to be read with their checks', async () => {
    // A form is not "okununca gönder" unless it says so.
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.masraf_formlari WHERE okununca_gonder = 1')).toEqual({ n: 0 });

    const me = await addUser('bekleyen@firma.test');
    const addForm = (durum: string, tutar: number | null, yerel: number | null) =>
      queryOne<{ id: number }>(
        db,
        `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, tutar, para_birimi, yerel_tutar, durum)
         OUTPUT inserted.id
         VALUES (@me, N'Masraf', (SELECT TOP (1) id FROM dbo.masraf_kategorileri), '2026-01-01', @t, 'TRY', @y, @d)`,
        { me: p.int(me), t: p.money(tutar), y: p.money(yerel), d: p.ascii(durum, 16) },
      );
    const draft = (await addForm('taslak', null, null))?.id ?? 0;
    expect(draft).toBeGreaterThan(0);
    // Every other state needs the amount; the local amount comes and goes with it.
    await expect(addForm('onayda', null, null)).rejects.toMatchObject({ number: 547 });
    await expect(addForm('taslak', 10, null)).rejects.toMatchObject({ number: 547 });
    await expect(addForm('taslak', null, 10)).rejects.toMatchObject({ number: 547 });
    await expect(addForm('taslak', 0, 0)).rejects.toMatchObject({ number: 547 });
    await expect(execute(db, `UPDATE dbo.masraf_formlari SET durum = 'onayda' WHERE id = @f`, { f: p.int(draft) })).rejects.toMatchObject({ number: 547 });

    const hash = 'a'.repeat(64);
    const waiting = (durum: string, kod: string | null, mesaj: string | null = null, ozet = hash) =>
      execute(
        db,
        `INSERT INTO dbo.bekleyen_faturalar (form_id, kullanici_id, dosya_adi, dosya_ozeti, mime, boyut, icerik, durum, hata_kodu, hata_mesaji)
         VALUES (@f, @u, N'fiş.jpg', @o, 'image/jpeg', 3, 0x010203, @d, @k, @m)`,
        { f: p.int(draft), u: p.int(me), o: p.ascii(ozet, 64), d: p.ascii(durum, 12), k: p.ascii(kod, 40), m: p.str(mesaj, 500) },
      );
    await waiting('bekliyor', null);
    // A file is on a form once.
    await expect(waiting('bekliyor', null)).rejects.toMatchObject({ number: 2601 });
    // A failure carries its code; a waiting file carries none.
    await expect(waiting('hata', null, null, 'b'.repeat(64))).rejects.toMatchObject({ number: 547 });
    await expect(waiting('bekliyor', 'claude_failed', null, 'b'.repeat(64))).rejects.toMatchObject({ number: 547 });
    await expect(waiting('okundu', null, null, 'b'.repeat(64))).rejects.toMatchObject({ number: 547 });
    await waiting('hata', 'claude_failed', 'Okunamadı.', 'b'.repeat(64));

    const user = p.int(me);
    for (const tur of ['okuma_bitti', 'okuma_hatasi', 'onaya_gonderildi', 'onaya_gonderilemedi']) {
      await execute(db, `INSERT INTO dbo.bildirimler (kullanici_id, tur, baslik, mesaj) VALUES (@u, @t, N'B', N'M')`, { u: user, t: p.ascii(tur, 20) });
    }

    // Deleting the form takes its waiting files with it.
    await execute(db, 'DELETE FROM dbo.masraf_formlari WHERE id = @f', { f: p.int(draft) });
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.bekleyen_faturalar')).toEqual({ n: 0 });
  });

  it('seeds the built-in fields, requiring invoice number, date, seller and grand total, and keeps the definition lists with their checks', async () => {
    const fields = await query<{ anahtar: string; duzey: string; tur: string; zorunlu: boolean; sistem: boolean }>(
      db,
      'SELECT anahtar, duzey, tur, zorunlu, sistem FROM dbo.alan_tanimlari ORDER BY duzey, sira',
    );
    expect(fields.filter((f) => f.zorunlu).map((f) => f.anahtar)).toEqual(['faturaNo', 'faturaTarihi', 'saticiUnvan', 'genelToplam', 'kategori']);
    expect(fields.filter((f) => f.tur === 'fatura').map((f) => f.anahtar)).toEqual([
      'faturaNo', 'faturaTarihi', 'saticiUnvan', 'saticiVergiNo', 'aliciUnvan', 'aliciVergiNo', 'paraBirimi', 'araToplam', 'kdvToplam', 'genelToplam',
    ]);
    expect(fields.every((f) => f.sistem === (f.tur === 'fatura' || f.duzey === 'form'))).toBe(true);
    const options = await query<{ anahtar: string; n: number }>(
      db,
      'SELECT a.anahtar, COUNT(*) AS n FROM dbo.alan_secenekleri s JOIN dbo.alan_tanimlari a ON a.id = s.alan_id GROUP BY a.anahtar ORDER BY a.anahtar',
    );
    expect(options).toEqual([{ anahtar: 'dokumanTipi', n: 6 }, { anahtar: 'odemeYontemi', n: 4 }]);

    // A system row cannot be a free-text field, and a form-level row cannot sit on a receipt.
    await expect(execute(db, `INSERT INTO dbo.alan_tanimlari (anahtar, ad, duzey, tur) VALUES ('x', N'X', 'fis', 'fatura')`)).rejects.toThrow();
    await expect(execute(db, `INSERT INTO dbo.alan_tanimlari (anahtar, ad, duzey, tur, sistem) VALUES ('y', N'Y', 'fis', 'masraf_merkezi', 1)`)).rejects.toThrow();
    // Codes are unique without regard to case.
    await execute(db, `INSERT INTO dbo.masraf_merkezleri (kod) VALUES (N'MM-1')`);
    await expect(execute(db, `INSERT INTO dbo.masraf_merkezleri (kod) VALUES (N'mm-1')`)).rejects.toThrow();
    // A value is an option or text, never both or neither.
    const user = await addUser('tanim@firma.test');
    await execute(db, `INSERT INTO dbo.fatura_kayitlari (id, dosya_adi, olusturma, sonuc) VALUES ('20261110-100000-aaaaaaaa', N'f.pdf', SYSUTCDATETIME(), N'{}')`);
    const form = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, tutar, para_birimi, yerel_tutar, durum)
       OUTPUT inserted.id VALUES (@u, N'F', (SELECT MIN(id) FROM dbo.masraf_kategorileri), '2026-11-10', 10, 'TRY', 10, 'taslak')`,
      { u: p.int(user) },
    );
    const f = p.int(form?.id ?? 0);
    await execute(db, `INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira) VALUES (@f, '20261110-100000-aaaaaaaa', 1)`, { f });
    const note = `(SELECT id FROM dbo.alan_tanimlari WHERE anahtar = 'not')`;
    await expect(execute(db, `INSERT INTO dbo.fis_alan_degerleri (form_id, kayit_id, alan_id) VALUES (@f, '20261110-100000-aaaaaaaa', ${note})`, { f })).rejects.toThrow();
    await execute(db, `INSERT INTO dbo.fis_alan_degerleri (form_id, kayit_id, alan_id, metin) VALUES (@f, '20261110-100000-aaaaaaaa', ${note}, N'Yıkama')`, { f });
    // Taking the invoice off the form takes its values with it.
    await execute(db, 'DELETE FROM dbo.form_faturalari WHERE form_id = @f', { f });
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.fis_alan_degerleri')).toEqual({ n: 0 });
  });

  it('keeps integrations and their sends with their checks, and deletes the sends with the integration', async () => {
    const user = await addUser('entegrasyon@firma.test');
    const insert = (cols: Record<string, string>) => {
      const all: Record<string, string> = { ad: `N'E${Math.random()}'`, adres: "N'http://pi.test/x'", bicim: "'json'", fis_listesi: "'FISLER'", fis_ogesi: "'FIS'", ...cols };
      return queryOne<{ id: number }>(db, `INSERT INTO dbo.entegrasyonlar (${Object.keys(all).join(', ')}) OUTPUT inserted.id VALUES (${Object.values(all).join(', ')})`);
    };
    const ok = await insert({ ad: "N'SAP PI'" });
    expect(await queryOne(db, 'SELECT aktif, yontem, tarih_bicimi, tetikleyici, kimlik_turu, basliklar, alanlar, zaman_asimi_sn FROM dbo.entegrasyonlar WHERE id = @i', { i: p.int(ok?.id ?? 0) })).toEqual({
      aktif: true,
      yontem: 'POST',
      tarih_bicimi: 'YYYY-AA-GG',
      tetikleyici: 'onaylandi',
      kimlik_turu: 'yok',
      basliklar: '[]',
      alanlar: '[]',
      zaman_asimi_sn: 30,
    });
    // Names are unique without regard to case, by Turkish rules (I ↔ ı).
    await expect(insert({ ad: "N'sap pı'" })).rejects.toMatchObject({ number: 2627 });
    await expect(insert({ bicim: "'csv'" })).rejects.toMatchObject({ number: 547 });
    await expect(insert({ yontem: "'GET'" })).rejects.toMatchObject({ number: 547 });
    await expect(insert({ tarih_bicimi: "'DD/MM/YYYY'" })).rejects.toMatchObject({ number: 547 });
    await expect(insert({ tetikleyici: "'taslak'" })).rejects.toMatchObject({ number: 547 });
    await expect(insert({ zaman_asimi_sn: '121' })).rejects.toMatchObject({ number: 547 });
    await expect(insert({ alanlar: "N'{bozuk'" })).rejects.toMatchObject({ number: 547 });
    // XML needs a root element.
    await expect(insert({ bicim: "'xml'" })).rejects.toMatchObject({ number: 547 });
    expect(await insert({ bicim: "'xml'", kok: "'MT_Masraf'" })).toEqual({ id: expect.any(Number) });
    // Basic needs a user and a sealed password; none without Basic.
    await expect(insert({ kimlik_turu: "'basic'", kullanici_adi: "N'PI'" })).rejects.toMatchObject({ number: 547 });
    await expect(insert({ kullanici_adi: "N'PI'" })).rejects.toMatchObject({ number: 547 });
    expect(await insert({ kimlik_turu: "'basic'", kullanici_adi: "N'PI'", sifre: '0x01' })).toEqual({ id: expect.any(Number) });

    const form = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, tutar, para_birimi, yerel_tutar, durum)
       OUTPUT inserted.id VALUES (@u, N'F', (SELECT MIN(id) FROM dbo.masraf_kategorileri), '2026-11-01', 10, 'TRY', 10, 'onaylandi')`,
      { u: p.int(user) },
    );
    const send = (durum: string, tetikleyen = 'onaylandi') =>
      execute(db, 'INSERT INTO dbo.entegrasyon_gonderimleri (entegrasyon_id, form_id, tetikleyen, durum) VALUES (@e, @f, @t, @d)', {
        e: p.int(ok?.id ?? 0),
        f: p.int(form?.id ?? 0),
        t: p.ascii(tetikleyen, 12),
        d: p.ascii(durum, 12),
      });
    for (const durum of ['bekliyor', 'gonderildi', 'hata']) await send(durum);
    await send('bekliyor', 'elle');
    await expect(send('atlandi')).rejects.toMatchObject({ number: 547 });
    await expect(send('bekliyor', 'taslak')).rejects.toMatchObject({ number: 547 });
    await execute(db, 'DELETE FROM dbo.entegrasyonlar WHERE id = @i', { i: p.int(ok?.id ?? 0) });
    expect(await queryOne(db, 'SELECT COUNT(*) AS n FROM dbo.entegrasyon_gonderimleri')).toEqual({ n: 0 });
  });

  it('refuses a database built from migration files that are gone, instead of taking it as up to date', async () => {
    const all = await loadMigrations();
    await execute(db, `INSERT INTO dbo.sema_surumleri (surum, ad) VALUES (99, N'099_form_faturalari.sql')`);
    const err = await migrate(db, all).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as Error).message).toContain('099_form_faturalari.sql');

    // A database built before the schema files were merged into one has the old 002-007 rows: it must not
    // be taken as having the merged file, nor the newer 002 under the same number.
    await execute(db, `DELETE FROM dbo.sema_surumleri WHERE surum = 99; UPDATE dbo.sema_surumleri SET ad = N'002_onay_stratejisi.sql' WHERE surum = 2`);
    await expect(migrate(db, all)).rejects.toThrow('002_onay_stratejisi.sql');

    // So is a renamed file under a number that exists.
    await execute(db, `UPDATE dbo.sema_surumleri SET ad = N'002_entegrasyonlar.sql' WHERE surum = 2; UPDATE dbo.sema_surumleri SET ad = N'001_eski.sql' WHERE surum = 1`);
    await expect(migrate(db, all)).rejects.toThrow('001_eski.sql');

    await execute(db, `UPDATE dbo.sema_surumleri SET ad = N'001_baslangic.sql' WHERE surum = 1`);
    expect(await migrate(db, all)).toEqual([]);
  });
});
