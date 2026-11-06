// Migrations run on a database that already holds data: 002 (several approval flows) and 003 (several
// invoices per form). The tests share one database and run in order.
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../src/db/database.ts';
import { loadDbConfig } from '../../src/config.ts';
import { execute, p, poolConfig, query, queryOne, type Db } from '../../src/db/sql.ts';
import { closeTestDb, testDb } from '../db.ts';

describe('migrations on existing data', () => {
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

  it('turns the existing flow into the default flow "Genel" and keeps who changed it last', async () => {
    const all = await loadMigrations();
    expect(await migrate(db, all.filter((m) => m.version === 1))).toEqual(['001_baslangic.sql']);
    const ids: number[] = [];
    for (const [i, ad] of ['Ayşe', 'Mehmet', 'Zeynep'].entries()) {
      const row = await queryOne<{ id: number }>(
        db,
        `INSERT INTO dbo.kullanicilar (eposta, ad_soyad, rol, sifre_ozeti) OUTPUT inserted.id VALUES (@e, @ad, 'yonetici', 'x')`,
        { e: p.str(`k${i}@firma.test`, 254), ad: p.str(ad, 120) },
      );
      ids.push(row?.id ?? 0);
    }
    await execute(db, 'INSERT INTO dbo.onay_adimlari (sira, onayci_id, alt_limit, ust_limit) VALUES (1, @a, 0, NULL), (2, @b, 5000.01, NULL)', {
      a: p.int(ids[0] ?? 0),
      b: p.int(ids[1] ?? 0),
    });
    await execute(db, `INSERT INTO dbo.denetim_kayitlari (kullanici_id, islem, ayrinti, tarih) VALUES (@k, 'onay_akisi_guncellendi', N'eski', '2026-01-02T03:04:05')`, {
      k: p.int(ids[2] ?? 0),
    });

    expect(await migrate(db, all.filter((m) => m.version <= 2))).toEqual(['002_onay_akislari.sql']);

    const flows = await query<{ id: number; ad: string; varsayilan: boolean; guncelleme: Date; guncelleyen_id: number | null }>(
      db,
      'SELECT id, ad, varsayilan, guncelleme, guncelleyen_id FROM dbo.onay_akislari',
    );
    expect(flows).toEqual([{ id: expect.any(Number), ad: 'Genel', varsayilan: true, guncelleme: new Date('2026-01-02T03:04:05Z'), guncelleyen_id: ids[2] }]);
    const steps = await query<{ akis_id: number; sira: number; onayci_id: number }>(db, 'SELECT akis_id, sira, onayci_id FROM dbo.onay_adimlari ORDER BY sira');
    expect(steps).toEqual([
      { akis_id: flows[0]?.id, sira: 1, onayci_id: ids[0] },
      { akis_id: flows[0]?.id, sira: 2, onayci_id: ids[1] },
    ]);
    const users = await query<{ onay_akisi_id: number | null }>(db, 'SELECT onay_akisi_id FROM dbo.kullanicilar');
    expect(users.every((u) => u.onay_akisi_id === null)).toBe(true);

    // The new rules hold in the schema: one default at most, names unique ignoring case, order unique per flow.
    await expect(execute(db, `INSERT INTO dbo.onay_akislari (ad, varsayilan) VALUES (N'İkinci', 1)`)).rejects.toMatchObject({ number: 2601 });
    await expect(execute(db, `INSERT INTO dbo.onay_akislari (ad) VALUES (N'GENEL')`)).rejects.toMatchObject({ number: 2601 });
    const other = await queryOne<{ id: number }>(db, `INSERT INTO dbo.onay_akislari (ad) OUTPUT inserted.id VALUES (N'Satış')`);
    await execute(db, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, alt_limit, ust_limit) VALUES (@f, 1, @a, 0, NULL)', {
      f: p.int(other?.id ?? 0),
      a: p.int(ids[0] ?? 0),
    });
    await expect(
      execute(db, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, alt_limit, ust_limit) VALUES (@f, 1, @b, 0, NULL)', {
        f: p.int(other?.id ?? 0),
        b: p.int(ids[1] ?? 0),
      }),
    ).rejects.toMatchObject({ number: 2601 });
  });

  it('moves the single invoice of each form into the invoice list, freeing those of cancelled forms', async () => {
    const user = await queryOne<{ id: number }>(
      db,
      `INSERT INTO dbo.kullanicilar (eposta, ad_soyad, rol, sifre_ozeti) OUTPUT inserted.id VALUES (N'fatura@firma.test', N'Fatura Sahibi', 'calisan', 'x')`,
    );
    const me = p.int(user?.id ?? 0);
    for (const id of ['20260101-000000-aaaaaaaa', '20260101-000000-bbbbbbbb']) {
      await execute(db, `INSERT INTO dbo.fatura_kayitlari (id, dosya_adi, olusturma, sonuc) VALUES (@id, N'f.pdf', SYSUTCDATETIME(), N'{}')`, { id: p.ascii(id, 24) });
    }
    const addForm = async (durum: string, invoice: string | null): Promise<number> => {
      const row = await queryOne<{ id: number }>(
        db,
        `INSERT INTO dbo.masraf_formlari (olusturan_id, baslik, kategori_id, masraf_tarihi, tutar, para_birimi, yerel_tutar, fatura_kayit_id, durum)
         OUTPUT inserted.id
         VALUES (@me, N'Masraf', (SELECT TOP (1) id FROM dbo.masraf_kategorileri), '2026-01-01', 10, 'TRY', 10, @f, @d)`,
        { me, f: p.ascii(invoice, 24), d: p.ascii(durum, 16) },
      );
      return row?.id ?? 0;
    };
    // 001 allowed an invoice on any number of cancelled forms and one live form.
    const cancelled = await addForm('iptal', '20260101-000000-aaaaaaaa');
    const live = await addForm('onayda', '20260101-000000-aaaaaaaa');
    const other = await addForm('taslak', '20260101-000000-bbbbbbbb');
    const none = await addForm('taslak', null);

    expect(await migrate(db, await loadMigrations())).toEqual(['003_form_faturalari.sql']);

    const links = await query<{ form_id: number; kayit_id: string; sira: number; aktif: boolean }>(
      db,
      'SELECT form_id, kayit_id, sira, aktif FROM dbo.form_faturalari ORDER BY form_id',
    );
    expect(links).toEqual([
      { form_id: cancelled, kayit_id: '20260101-000000-aaaaaaaa', sira: 1, aktif: false },
      { form_id: live, kayit_id: '20260101-000000-aaaaaaaa', sira: 1, aktif: true },
      { form_id: other, kayit_id: '20260101-000000-bbbbbbbb', sira: 1, aktif: true },
    ]);
    expect(links.some((l) => l.form_id === none)).toBe(false);
    const column = await queryOne(db, `SELECT 1 AS x FROM sys.columns WHERE object_id = OBJECT_ID('dbo.masraf_formlari') AND name = 'fatura_kayit_id'`);
    expect(column).toBeNull();

    // Still one live form per invoice, and an invoice once per form.
    await expect(
      execute(db, `INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira) VALUES (@f, '20260101-000000-aaaaaaaa', 2)`, { f: p.int(other) }),
    ).rejects.toMatchObject({ number: 2601 });
    await expect(
      execute(db, `INSERT INTO dbo.form_faturalari (form_id, kayit_id, sira, aktif) VALUES (@f, '20260101-000000-bbbbbbbb', 2, 0)`, { f: p.int(other) }),
    ).rejects.toMatchObject({ number: 2627 });
  });
});
