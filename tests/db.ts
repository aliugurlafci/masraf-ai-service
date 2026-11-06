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

/**
 * Empties every table and puts back the seeded categories (ids 1–9). Only the default approval flow
 * stays, empty, named "Genel" and a chain ('zincir') as the migrations leave it. A read still finishing from the
 * previous test may insert a row mid-reset (foreign key error) or deadlock with it; then it tries again.
 */
export async function resetDb(db: Db): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await transaction(db, (tx) =>
        execute(
          tx,
          `DELETE FROM dbo.form_gecmisi; DELETE FROM dbo.form_onaylari; DELETE FROM dbo.form_faturalari; DELETE FROM dbo.masraf_formlari;
           DELETE FROM dbo.fatura_yuklemeleri; DELETE FROM dbo.fatura_dosyalari; DELETE FROM dbo.fatura_kayitlari;
           DELETE FROM dbo.onay_adimlari; UPDATE dbo.onay_akislari SET guncelleyen_id = NULL;
           DELETE FROM dbo.oturumlar; DELETE FROM dbo.denetim_kayitlari;
           DELETE FROM dbo.masraf_kategorileri; DELETE FROM dbo.kullanicilar;
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
     SET IDENTITY_INSERT dbo.masraf_kategorileri OFF;`,
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
 * Returns the record id. `fatura` overrides fields of sampleInvoice() (genelToplam 1800 TRY).
 */
export async function makeInvoice(
  db: Db,
  userId: number,
  fatura: Partial<Invoice['fatura']> = {},
  dosya: InvoiceFile | null = { icerik: PDF_BYTES, mime: 'application/pdf' },
): Promise<string> {
  const storage = createInvoiceStorage(db);
  const record = await storage.save({ dosyaAdi: 'fatura.pdf', sonuc: sampleInvoice(fatura), yukleyenId: userId, ...(dosya !== null ? { dosya } : {}) });
  await storage.addUpload({ kayitId: record.id, kullaniciId: userId, dosyaAdi: 'fatura.pdf' });
  return record.id;
}

export type Steps = ReadonlyArray<{ onayciId: number; limit: number | null }>;

/**
 * Steps every amount above a few cents passes, approver by approver, in a 'zincir' flow: limits 0,01,
 * 0,02, … and none for the last one. One id gives a single approver without a limit. This is what a
 * flow whose approvers all started at 0 became (see 002_onay_stratejisi.sql).
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
