// The schema files on an empty database: what the first one builds, how the second one turns the old
// amount ranges of the approval flows into strategies and approval limits, the rules the schema itself
// enforces, and a database built from migration files that no longer exist. The tests share one
// database and run in order.
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planApprovals, validateFlow } from '../../src/approval/flow.ts';
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

  it('builds the schema from the first file, once, with the default flow and the categories', async () => {
    const all = await loadMigrations();
    expect(all.map((m) => m.name)).toEqual(['001_baslangic.sql', '002_onay_stratejisi.sql']);
    const first = all.filter((m) => m.version === 1);
    expect(await migrate(db, first)).toEqual(['001_baslangic.sql']);
    expect(await migrate(db, first)).toEqual([]);

    expect(await query(db, 'SELECT ad, varsayilan FROM dbo.onay_akislari')).toEqual([{ ad: 'Genel', varsayilan: true }]);
    const categories = await query<{ ad: string }>(db, 'SELECT ad FROM dbo.masraf_kategorileri ORDER BY sira');
    expect(categories.map((c) => c.ad)).toEqual(['Yemek', 'Ulaşım', 'Konaklama', 'Akaryakıt', 'Ofis malzemesi', 'Temsil ve ağırlama', 'Eğitim', 'İletişim', 'Diğer']);
    // Invoices hang off the form through form_faturalari only.
    const column = await queryOne(db, `SELECT 1 AS x FROM sys.columns WHERE object_id = OBJECT_ID('dbo.masraf_formlari') AND name = 'fatura_kayit_id'`);
    expect(column).toBeNull();
  });

  it('turns the amount ranges of existing flows into a strategy and approval limits', async () => {
    const [ayse, mehmet, zeynep, dora] = [
      await addUser('ayse@goc.test'),
      await addUser('mehmet@goc.test'),
      await addUser('zeynep@goc.test'),
      await addUser('dora@goc.test'),
    ];
    const genel = (await queryOne<{ id: number }>(db, 'SELECT id FROM dbo.onay_akislari WHERE varsayilan = 1'))?.id ?? 0;
    /** A flow as the first schema file kept it: [approver, lower limit, upper limit] in order. */
    const oldFlow = async (ad: string, steps: Array<[number, number, number | null]>): Promise<number> => {
      const id =
        ad === 'Genel'
          ? genel
          : ((await queryOne<{ id: number }>(db, 'INSERT INTO dbo.onay_akislari (ad) OUTPUT inserted.id VALUES (@ad)', { ad: p.str(ad, 80) }))?.id ?? 0);
      for (const [i, [onayci, alt, ust]] of steps.entries()) {
        await execute(db, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, alt_limit, ust_limit) VALUES (@f, @s, @o, @a, @u)', {
          f: p.int(id),
          s: p.int(i + 1),
          o: p.int(onayci),
          a: p.money(alt),
          u: p.money(ust),
        });
      }
      return id;
    };
    // Every approver but the last has an upper limit: each amount went to one approver ('tek').
    await oldFlow('Genel', [
      [ayse, 0, 1000],
      [mehmet, 1000, null],
    ]); // the flow of the installation this replaces
    await oldFlow('Ayrık', [
      [ayse, 0, 5000],
      [mehmet, 5000.01, 50000],
      [zeynep, 50000.01, null],
    ]);
    // Unlimited ranges starting higher and higher: an escalation chain ('zincir').
    const kademe = await oldFlow('Kademe', [
      [ayse, 0, null],
      [mehmet, 5000.01, null],
      [zeynep, 50000.01, null],
    ]);
    await oldFlow('Tek kişi', [[zeynep, 0, null]]);
    await oldFlow('Boş', []);
    // Shapes the new rules have no exact match for; see below what they become.
    await oldFlow('Hepsi sıfırdan', [
      [ayse, 0, null],
      [mehmet, 0, null],
    ]);
    await oldFlow('Sıfır', [
      [ayse, 0, 0],
      [mehmet, 0.01, null],
    ]);
    await oldFlow('Çakışan', [
      [ayse, 0, null],
      [mehmet, 1000, 5000],
      [zeynep, 2000, null],
    ]);
    await oldFlow('Ters', [
      [ayse, 0, 5000],
      [mehmet, 0, 1000],
      [zeynep, 1000.01, null],
    ]);
    await execute(db, 'UPDATE dbo.kullanicilar SET onay_akisi_id = @f WHERE id = @u', { f: p.int(kademe), u: p.int(dora) });

    const all = await loadMigrations();
    expect(await migrate(db, all)).toEqual(['002_onay_stratejisi.sql']);
    expect(await migrate(db, all)).toEqual([]);

    const rows = await query<{ ad: string; varsayilan: boolean; strateji: string; sira: number | null; onayci_id: number | null; onay_limiti: number | null }>(
      db,
      `SELECT a.ad, a.varsayilan, a.strateji, s.sira, s.onayci_id, s.onay_limiti
       FROM dbo.onay_akislari a LEFT JOIN dbo.onay_adimlari s ON s.akis_id = a.id ORDER BY a.id, s.sira`,
    );
    const flows = new Map<string, { strateji: string; adimlar: Array<[number, number | null]> }>();
    for (const r of rows) {
      const flow = flows.get(r.ad) ?? { strateji: r.strateji, adimlar: [] };
      if (r.sira !== null) flow.adimlar.push([r.onayci_id ?? 0, r.onay_limiti]);
      flows.set(r.ad, flow);
    }
    expect(Object.fromEntries(flows)).toEqual({
      Genel: { strateji: 'tek', adimlar: [[ayse, 1000], [mehmet, null]] },
      Ayrık: { strateji: 'tek', adimlar: [[ayse, 5000], [mehmet, 50000], [zeynep, null]] },
      Kademe: { strateji: 'zincir', adimlar: [[ayse, 5000], [mehmet, 50000], [zeynep, null]] },
      'Tek kişi': { strateji: 'zincir', adimlar: [[zeynep, null]] },
      Boş: { strateji: 'zincir', adimlar: [] },
      // Both from 0: everyone sees every amount above a single cent.
      'Hepsi sıfırdan': { strateji: 'zincir', adimlar: [[ayse, 0.01], [mehmet, null]] },
      // A range of the single amount 0 (no expense has it) becomes the smallest limit.
      Sıfır: { strateji: 'tek', adimlar: [[ayse, 0.01], [mehmet, null]] },
      // The middle upper limit is dropped: a chain, each limit just below the next lower limit.
      Çakışan: { strateji: 'zincir', adimlar: [[ayse, 999.99], [mehmet, 1999.99], [zeynep, null]] },
      // Upper limits out of order are kept as they are.
      Ters: { strateji: 'tek', adimlar: [[ayse, 5000], [mehmet, 1000], [zeynep, null]] },
    });
    expect(rows.find((r) => r.ad === 'Genel')?.varsayilan).toBe(true);
    expect(await queryOne(db, 'SELECT onay_akisi_id FROM dbo.kullanicilar WHERE id = @u', { u: p.int(dora) })).toEqual({ onay_akisi_id: kademe });

    // Every converted flow follows the new rules except the one whose upper limits were out of order
    // (and the empty one, as before): an administrator has to fix it on its next save.
    const problems = [...flows].map(([ad, f]) => [ad, validateFlow(f.adimlar.map(([onayciId, limit]) => ({ onayciId, limit })), 'TRY')] as const);
    expect(Object.fromEntries(problems.filter(([, list]) => list.length > 0))).toEqual({
      Boş: ['Onay akışında en az bir onaycı olmalıdır.'],
      Ters: ['2. onaycının limiti, 1. onaycınınkinden (5.000,00 TRY) büyük olmalıdır.'],
    });
    // The overlapping flow now also sends amounts above 5.000 to Mehmet (before: Ayşe and Zeynep only).
    const cakisan = (flows.get('Çakışan')?.adimlar ?? []).map(([onayciId, limit], i) => ({ sira: i + 1, onayciId, limit }));
    expect(planApprovals('zincir', cakisan, 6000, dora, [])?.map((s) => s.onayciId)).toEqual([ayse, mehmet, zeynep]);
    expect(planApprovals('zincir', cakisan, 1500, dora, [])?.map((s) => s.onayciId)).toEqual([ayse, mehmet]);

    // The old range columns are gone from the flow; a form's approval rows keep the band they were sent with.
    const columns = async (table: string): Promise<string[]> =>
      (await query<{ name: string }>(db, 'SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t) ORDER BY column_id', { t: p.str(table, 128) })).map(
        (c) => c.name,
      );
    expect(await columns('dbo.onay_adimlari')).toEqual(['id', 'akis_id', 'sira', 'onayci_id', 'onay_limiti']);
    expect(await columns('dbo.onay_akislari')).toContain('strateji');
    expect(await columns('dbo.form_onaylari')).toEqual(expect.arrayContaining(['alt_limit', 'ust_limit']));
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

  it('refuses a database built from migration files that are gone, instead of taking it as up to date', async () => {
    const all = await loadMigrations();
    await execute(db, `INSERT INTO dbo.sema_surumleri (surum, ad) VALUES (3, N'003_form_faturalari.sql')`);
    const err = await migrate(db, all).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as Error).message).toContain('003_form_faturalari.sql');

    // Another file under a number that exists is the same case: a database built before the schema
    // files were merged has 002_onay_akislari.sql and must not be taken as having the new 002.
    await execute(db, `DELETE FROM dbo.sema_surumleri WHERE surum = 3; UPDATE dbo.sema_surumleri SET ad = N'002_onay_akislari.sql' WHERE surum = 2`);
    await expect(migrate(db, all)).rejects.toThrow('002_onay_akislari.sql');

    // So is a renamed file.
    await execute(db, `UPDATE dbo.sema_surumleri SET ad = N'002_onay_stratejisi.sql' WHERE surum = 2; UPDATE dbo.sema_surumleri SET ad = N'001_eski.sql' WHERE surum = 1`);
    await expect(migrate(db, all)).rejects.toThrow('001_eski.sql');

    await execute(db, `UPDATE dbo.sema_surumleri SET ad = N'001_baslangic.sql' WHERE surum = 1`);
    expect(await migrate(db, all)).toEqual([]);
  });
});
