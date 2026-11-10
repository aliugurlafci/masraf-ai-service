// Test database helpers. Database tests run against the SQL Server in Docker (npm run db:up), each
// Vitest worker in its own database "<MSSQL_DATABASE>_test_<n>", so files can run in parallel.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Strateji } from '../src/approval/flow.ts';
import { hashPassword } from '../src/auth/password.ts';
import { openSession } from '../src/auth/sessions.ts';
import { ConfigError, loadDbConfig, ROOT_DIR } from '../src/config.ts';
import { openDatabase } from '../src/db/database.ts';
import { execute, p, queryOne, sqlErrorNumber, transaction, type Db } from '../src/db/sql.ts';
import type { Rol } from '../src/expenses/rules.ts';
import type { Invoice } from '../src/invoice/schema.ts';
import { createInvoiceStorage, type InvoiceFile } from '../src/invoice/storage.ts';
import { getUser, type Kullanici } from '../src/users/users.ts';
import { PDF_BYTES, sampleInvoice } from './helpers.ts';

export const TEST_PASSWORD = 'Deneme1234';

let opened: Promise<Db> | null = null;

/** The worker's test database, created and migrated on first use. */
export function testDb(): Promise<Db> {
  opened ??= (async () => {
    const envFile = join(ROOT_DIR, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set
    let config;
    try {
      config = loadDbConfig(process.env);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new Error(`Veritabanı testleri MSSQL ister: .env dosyasında MSSQL_PASSWORD tanımlayın ve "npm run db:up" çalıştırın. (${err.message})`);
      }
      throw err;
    }
    const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0';
    try {
      return await openDatabase({ ...config, connectWaitMs: 5_000, poolMax: 5 }, { database: `${config.database}_test_${worker}` });
    } catch (err) {
      throw new Error(`Test veritabanına bağlanılamadı; "npm run db:up" ile SQL Server'ı başlatın. ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return opened;
}

export async function closeTestDb(): Promise<void> {
  if (opened === null) return;
  const db = await opened.catch(() => null);
  opened = null;
  await db?.close();
}

const SEED_CATEGORIES: ReadonlyArray<[number, string, string]> = [
  [1, 'Yemek', 'yemek'],
  [2, 'Ulaşım', 'ulasim'],
  [3, 'Konaklama', 'konaklama'],
  [4, 'Akaryakıt', 'akaryakit'],
  [5, 'Ofis malzemesi', 'ofis'],
  [6, 'Temsil ve ağırlama', 'temsil'],
  [7, 'Eğitim', 'egitim'],
  [8, 'İletişim', 'iletisim'],
  [9, 'Diğer', 'diger'],
];

/** The fields and options the schema file seeds, as it leaves them; ids differ after every reset, so tests look fields up by key. */
const SEED_FIELDS = `
  INSERT INTO dbo.alan_tanimlari (anahtar, ad, duzey, tur, zorunlu, sira, sistem) VALUES
    ('kategori', N'Kategori', 'form', 'kategori', 1, 1, 1),
    ('masrafMerkezi', N'Masraf Merkezi', 'form', 'masraf_merkezi', 0, 2, 1),
    ('faturaNo', N'Fatura No', 'fis', 'fatura', 1, 1, 1),
    ('faturaTarihi', N'Fatura Tarihi', 'fis', 'fatura', 1, 2, 1),
    ('saticiUnvan', N'Satıcı', 'fis', 'fatura', 1, 3, 1),
    ('saticiVergiNo', N'Satıcı Vergi No', 'fis', 'fatura', 0, 4, 1),
    ('aliciUnvan', N'Alıcı', 'fis', 'fatura', 0, 5, 1),
    ('aliciVergiNo', N'Alıcı Vergi No', 'fis', 'fatura', 0, 6, 1),
    ('paraBirimi', N'Para Birimi', 'fis', 'fatura', 0, 7, 1),
    ('araToplam', N'Ara Toplam', 'fis', 'fatura', 0, 8, 1),
    ('kdvToplam', N'KDV Toplamı', 'fis', 'fatura', 0, 9, 1),
    ('genelToplam', N'Genel Toplam', 'fis', 'fatura', 1, 10, 1),
    ('etiket', N'Etiket', 'fis', 'liste', 0, 11, 0),
    ('projeKodu', N'Proje Kodu', 'fis', 'liste', 0, 12, 0),
    ('odemeYontemi', N'Ödeme Yöntemi', 'fis', 'liste', 0, 13, 0),
    ('dokumanTipi', N'Doküman Tipi', 'fis', 'liste', 0, 14, 0),
    ('kkegTuru', N'KKEG Türü', 'fis', 'liste', 0, 15, 0),
    ('vergiDairesi', N'Vergi Dairesi', 'fis', 'metin', 0, 16, 0),
    ('not', N'Not', 'fis', 'uzun_metin', 0, 17, 0);
  INSERT INTO dbo.alan_secenekleri (alan_id, kod, sira)
  SELECT a.id, v.kod, v.sira FROM dbo.alan_tanimlari a JOIN (VALUES
    ('odemeYontemi', N'Nakit', 1), ('odemeYontemi', N'Kredi Kartı', 2), ('odemeYontemi', N'Şirket Kartı', 3), ('odemeYontemi', N'Banka Havalesi', 4),
    ('dokumanTipi', N'Fiş', 1), ('dokumanTipi', N'Fatura', 2), ('dokumanTipi', N'e-Arşiv Fatura', 3), ('dokumanTipi', N'e-Fatura', 4),
    ('dokumanTipi', N'Serbest Meslek Makbuzu', 5), ('dokumanTipi', N'Gider Pusulası', 6)
  ) v (anahtar, kod, sira) ON a.anahtar = v.anahtar;`;

/**
 * Empties every table and puts back the seeded categories (ids 1–9) and the seeded fields. Only the default approval flow
 * stays, empty, named "Genel" and a chain ('zincir') as the migrations leave it. A read still finishing from the
 * previous test may insert a row mid-reset (foreign key error) or deadlock with it; then it tries again.
 */
export async function resetDb(db: Db): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await transaction(db, (tx) =>
        execute(
          tx,
          `DELETE FROM dbo.bildirimler; DELETE FROM dbo.eposta_kutusu; DELETE FROM dbo.form_gecmisi; DELETE FROM dbo.form_onaylari; DELETE FROM dbo.fis_alan_degerleri; DELETE FROM dbo.bekleyen_alan_degerleri; DELETE FROM dbo.form_faturalari; DELETE FROM dbo.bekleyen_faturalar; DELETE FROM dbo.masraf_formlari;
           DELETE FROM dbo.fatura_yuklemeleri; DELETE FROM dbo.fatura_dosyalari; DELETE FROM dbo.fatura_kayitlari;
           DELETE FROM dbo.onay_adimlari; UPDATE dbo.onay_akislari SET guncelleyen_id = NULL;
           DELETE FROM dbo.oturumlar; DELETE FROM dbo.denetim_kayitlari;
           DELETE FROM dbo.masraf_kategorileri; DELETE FROM dbo.kullanici_masraf_merkezleri; DELETE FROM dbo.kullanicilar;
           DELETE FROM dbo.organizasyonlar; DELETE FROM dbo.masraf_merkezleri;
           DELETE FROM dbo.alan_kurali_hedefleri; DELETE FROM dbo.alan_kurallari; DELETE FROM dbo.alan_secenekleri; DELETE FROM dbo.alan_tanimlari;
           DELETE FROM dbo.onay_akislari WHERE varsayilan = 0; UPDATE dbo.onay_akislari SET ad = N'Genel', strateji = 'zincir';`,
        ),
      );
      break;
    } catch (err) {
      const n = sqlErrorNumber(err);
      if (attempt >= 10 || (n !== 547 && n !== 1205)) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await execute(
    db,
    `SET IDENTITY_INSERT dbo.masraf_kategorileri ON;
     INSERT INTO dbo.masraf_kategorileri (id, ad, simge, sira) VALUES ${SEED_CATEGORIES.map((_, i) => `(@i${i}, @a${i}, @s${i}, @i${i})`).join(', ')};
     SET IDENTITY_INSERT dbo.masraf_kategorileri OFF;
     ${SEED_FIELDS}`,
    Object.fromEntries(SEED_CATEGORIES.flatMap(([id, ad, s], i) => [[`i${i}`, p.int(id)], [`a${i}`, p.str(ad, 60)], [`s${i}`, p.ascii(s, 16)]])),
  );
}

let passwordHash: Promise<string> | null = null;

export interface UserSpec {
  readonly adSoyad?: string;
  readonly eposta?: string;
  readonly rol?: Rol;
  readonly departman?: string | null;
  readonly aktif?: boolean;
  readonly sifreDegismeli?: boolean;
}

let counter = 0;

/** Inserts a user whose password is TEST_PASSWORD (hashed once per file to keep tests fast). */
export async function makeUser(db: Db, spec: UserSpec = {}): Promise<Kullanici> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  counter++;
  const row = await queryOne<{ id: number }>(
    db,
    `INSERT INTO dbo.kullanicilar (eposta, ad_soyad, rol, departman, sifre_ozeti, aktif, sifre_degismeli)
     OUTPUT inserted.id VALUES (@e, @ad, @rol, @dep, @h, @aktif, @sd)`,
    {
      e: p.str(spec.eposta ?? `kisi${counter}-${Date.now()}@firma.test`, 254),
      ad: p.str(spec.adSoyad ?? `Kişi ${counter}`, 120),
      rol: p.ascii(spec.rol ?? 'calisan', 16),
      dep: p.str(spec.departman ?? null, 80),
      h: p.ascii(await passwordHash, 256),
      aktif: p.bit(spec.aktif ?? true),
      sd: p.bit(spec.sifreDegismeli ?? false),
    },
  );
  if (row === null) throw new Error('test kullanıcısı eklenemedi');
  return (await getUser(db, row.id)) as Kullanici;
}

/** A bearer token for the user, as the mobile app would hold. */
export async function tokenFor(db: Db, userId: number): Promise<string> {
  return (await openSession(db, userId, 'mobil', 3_600_000)).token;
}

/**
 * Stores an invoice record as if `userId` had uploaded it, with its original file unless `dosya` is null.
 * Returns the record id. `fatura` overrides fields of sampleInvoice() (genelToplam 1800 TRY); the seller's
 * tax number is unique per call unless given.
 */
let invoiceCount = 0;

export async function makeInvoice(
  db: Db,
  userId: number,
  fatura: Partial<Invoice['fatura']> = {},
  dosya: InvoiceFile | null = { icerik: PDF_BYTES, mime: 'application/pdf' },
): Promise<string> {
  const storage = createInvoiceStorage(db);
  // Each invoice gets its own seller tax number unless one is given, so two invoices are never
  // duplicates (same seller tax number and invoice number) by accident.
  invoiceCount++;
  const sonuc = sampleInvoice({ saticiVergiNo: String(1_000_000_000 + invoiceCount), ...fatura });
  const record = await storage.save({ dosyaAdi: 'fatura.pdf', sonuc, yukleyenId: userId, ...(dosya !== null ? { dosya } : {}) });
  await storage.addUpload({ kayitId: record.id, kullaniciId: userId, dosyaAdi: 'fatura.pdf' });
  return record.id;
}

export type Steps = ReadonlyArray<{ onayciId: number; limit: number | null }>;

/**
 * Steps every amount above a few cents passes, approver by approver, in a 'zincir' flow: limits 0,01,
 * 0,02, … and none for the last one. One id gives a single approver without a limit. This is what a
 * flow whose approvers all started at 0 became when amount ranges gave way to approval limits.
 */
export const chainOf = (...ids: readonly number[]): Steps => ids.map((onayciId, i) => ({ onayciId, limit: i === ids.length - 1 ? null : (i + 1) / 100 }));

/** The id of the default approval flow. */
export async function defaultFlowId(db: Db): Promise<number> {
  const row = await queryOne<{ id: number }>(db, 'SELECT id FROM dbo.onay_akislari WHERE varsayilan = 1');
  if (row === null) throw new Error('varsayılan onay akışı yok');
  return row.id;
}

/**
 * Replaces the strategy and the steps of an approval flow directly (the service's checks are tested
 * elsewhere). Without `flowId` it is the default flow.
 */
export async function setFlow(db: Db, steps: Steps, strateji: Strateji = 'zincir', flowId?: number): Promise<void> {
  const id = flowId ?? (await defaultFlowId(db));
  await execute(db, 'UPDATE dbo.onay_akislari SET strateji = @st WHERE id = @f', { f: p.int(id), st: p.ascii(strateji, 8) });
  await execute(db, 'DELETE FROM dbo.onay_adimlari WHERE akis_id = @f', { f: p.int(id) });
  for (const [i, s] of steps.entries()) {
    await execute(db, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, onay_limiti) VALUES (@f, @s, @o, @l)', {
      f: p.int(id),
      s: p.int(i + 1),
      o: p.int(s.onayciId),
      l: p.money(s.limit),
    });
  }
}

/** Adds a (non-default) approval flow with the given strategy and steps and returns its id. */
export async function makeFlow(db: Db, ad: string, steps: Steps, strateji: Strateji = 'zincir'): Promise<number> {
  const row = await queryOne<{ id: number }>(db, 'INSERT INTO dbo.onay_akislari (ad) OUTPUT inserted.id VALUES (@ad)', { ad: p.str(ad, 80) });
  if (row === null) throw new Error('test onay akışı eklenemedi');
  await setFlow(db, steps, strateji, row.id);
  return row.id;
}

/** Assigns a user to a flow (null = the default) directly. */
export async function assignFlow(db: Db, userId: number, flowId: number | null): Promise<void> {
  await execute(db, 'UPDATE dbo.kullanicilar SET onay_akisi_id = @f WHERE id = @u', { f: p.int(flowId), u: p.int(userId) });
}

/** Inserts an organisation; returns its id. */
export async function makeOrganization(db: Db, kod: string, ad = `${kod} A.Ş.`, aktif = true): Promise<number> {
  const row = await queryOne<{ id: number }>(db, 'INSERT INTO dbo.organizasyonlar (kod, ad, aktif) OUTPUT inserted.id VALUES (@k, @a, @ak)', {
    k: p.str(kod, 50),
    a: p.str(ad, 200),
    ak: p.bit(aktif),
  });
  return row?.id ?? 0;
}

/** Inserts a cost centre; returns its id. */
export async function makeCostCenter(db: Db, kod: string, aciklama: string | null = null, aktif = true): Promise<number> {
  const row = await queryOne<{ id: number }>(db, 'INSERT INTO dbo.masraf_merkezleri (kod, aciklama, aktif) OUTPUT inserted.id VALUES (@k, @a, @ak)', {
    k: p.str(kod, 50),
    a: p.str(aciklama, 200),
    ak: p.bit(aktif),
  });
  return row?.id ?? 0;
}

/** Sets the user's organisation and cost centres directly (replaces the cost centres). */
export async function assignDefinitions(db: Db, userId: number, organizasyonId: number | null, masrafMerkeziIdler: readonly number[] = []): Promise<void> {
  await execute(db, 'UPDATE dbo.kullanicilar SET organizasyon_id = @o WHERE id = @u; DELETE FROM dbo.kullanici_masraf_merkezleri WHERE kullanici_id = @u', {
    o: p.int(organizasyonId),
    u: p.int(userId),
  });
  for (const id of masrafMerkeziIdler) {
    await execute(db, 'INSERT INTO dbo.kullanici_masraf_merkezleri (kullanici_id, masraf_merkezi_id) VALUES (@u, @m)', { u: p.int(userId), m: p.int(id) });
  }
}

/** The id of a field by its key. */
export async function fieldId(db: Db, anahtar: string): Promise<number> {
  const row = await queryOne<{ id: number }>(db, 'SELECT id FROM dbo.alan_tanimlari WHERE anahtar = @a', { a: p.ascii(anahtar, 40) });
  if (row === null) throw new Error(`alan yok: ${anahtar}`);
  return row.id;
}

/** Inserts an option into a 'liste' field (by key); returns its id. */
export async function makeOption(db: Db, anahtar: string, kod: string, ad: string | null = null, aktif = true): Promise<number> {
  const row = await queryOne<{ id: number }>(
    db,
    'INSERT INTO dbo.alan_secenekleri (alan_id, kod, ad, aktif) OUTPUT inserted.id VALUES (@f, @k, @a, @ak)',
    { f: p.int(await fieldId(db, anahtar)), k: p.str(kod, 50), a: p.str(ad, 200), ak: p.bit(aktif) },
  );
  return row?.id ?? 0;
}

/** The id of an option of a field, by code. */
export async function optionId(db: Db, anahtar: string, kod: string): Promise<number> {
  const row = await queryOne<{ id: number }>(db, 'SELECT id FROM dbo.alan_secenekleri WHERE alan_id = @f AND kod = @k', {
    f: p.int(await fieldId(db, anahtar)),
    k: p.str(kod, 50),
  });
  if (row === null) throw new Error(`seçenek yok: ${anahtar}/${kod}`);
  return row.id;
}
