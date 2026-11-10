import { audit } from '../db/audit.ts';
import { execute, isUniqueViolation, p, query, queryOne, SQL_ERROR, sqlErrorNumber, transaction, type Db, type Executor, type Param } from '../db/sql.ts';
import { deleteRulesOf, lockList } from '../definitions/list-tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { Actor } from './rules.ts';

export const ICONS = ['yemek', 'ulasim', 'konaklama', 'akaryakit', 'ofis', 'temsil', 'egitim', 'iletisim', 'diger'] as const;
export type Simge = (typeof ICONS)[number];

export interface Kategori {
  readonly id: number;
  readonly ad: string;
  readonly simge: Simge;
  readonly aktif: boolean;
  readonly sira: number;
  /** Accounting details, carried by Excel; null = not set. */
  readonly kod: string | null;
  readonly kdvOranlari: string | null;
  readonly hesapKodu: string | null;
}

/** Accounting details: undefined leaves the value, null or empty text clears it. */
interface CategoryDetails {
  readonly kod?: string | null | undefined;
  readonly kdvOranlari?: string | null | undefined;
  readonly hesapKodu?: string | null | undefined;
}

export interface NewCategory extends CategoryDetails {
  readonly ad: string;
  readonly simge?: Simge | undefined;
}

export interface CategoryPatch extends CategoryDetails {
  readonly ad?: string | undefined;
  readonly simge?: Simge | undefined;
  readonly aktif?: boolean | undefined;
  readonly sira?: number | undefined;
}

const SELECT = 'SELECT id, ad, simge, aktif, sira, kod, kdv_oranlari AS kdvOranlari, hesap_kodu AS hesapKodu FROM dbo.masraf_kategorileri';
const LOCK = 'kategoriler';
const DETAILS = [
  ['kod', 'kod'],
  ['kdvOranlari', 'kdv_oranlari'],
  ['hesapKodu', 'hesap_kodu'],
] as const;
const taken = (): Error => conflict('kategori_var', 'Bu adla bir kategori zaten var.');
const inUse = (): Error => conflict('kullaniliyor', 'Bu kategori masraf formlarında kullanılıyor; silinemez. Silmek yerine pasifleştirin.');
const detail = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === '' ? null : v.trim());

export async function listCategories(db: Db, includeInactive: boolean): Promise<Kategori[]> {
  return query<Kategori>(db, `${SELECT} ${includeInactive ? '' : 'WHERE aktif = 1'} ORDER BY sira, ad`);
}

export async function getCategory(ex: Executor, id: number): Promise<Kategori | null> {
  return queryOne<Kategori>(ex, `${SELECT} WHERE id = @id`, { id: p.int(id) });
}

export async function createCategory(db: Db, actor: Actor, input: NewCategory): Promise<Kategori> {
  try {
    return await transaction(db, async (tx) => {
      await lockList(tx, LOCK);
      const row = await queryOne<{ id: number }>(
        tx,
        `INSERT INTO dbo.masraf_kategorileri (ad, simge, sira, kod, kdv_oranlari, hesap_kodu)
         OUTPUT inserted.id
         VALUES (@ad, @s, (SELECT ISNULL(MAX(sira), 0) + 1 FROM dbo.masraf_kategorileri), @kod, @kdv, @hesap)`,
        {
          ad: p.str(input.ad.trim(), 60),
          s: p.ascii(input.simge ?? 'diger', 16),
          kod: p.str(detail(input.kod), 50),
          kdv: p.str(detail(input.kdvOranlari), 50),
          hesap: p.str(detail(input.hesapKodu), 50),
        },
      );
      if (row === null) throw new Error('kategori eklenemedi');
      await audit(tx, actor.id, 'kategori_olusturuldu', input.ad.trim());
      return (await getCategory(tx, row.id)) as Kategori;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
}

export async function updateCategory(db: Db, actor: Actor, id: number, patch: CategoryPatch): Promise<Kategori> {
  try {
    return await transaction(db, async (tx) => {
      await lockList(tx, LOCK);
      const before = await getCategory(tx, id);
      if (before === null) throw notFound('Kategori bulunamadı.');
      const sets: string[] = [];
      const params: Record<string, Param> = { id: p.int(id) };
      if (patch.ad !== undefined) {
        sets.push('ad = @ad');
        params.ad = p.str(patch.ad.trim(), 60);
      }
      if (patch.simge !== undefined) {
        sets.push('simge = @s');
        params.s = p.ascii(patch.simge, 16);
      }
      if (patch.aktif !== undefined) {
        sets.push('aktif = @aktif');
        params.aktif = p.bit(patch.aktif);
      }
      if (patch.sira !== undefined) {
        sets.push('sira = @sira');
        params.sira = p.int(patch.sira);
      }
      for (const [name, column] of DETAILS) {
        if (patch[name] === undefined) continue;
        sets.push(`${column} = @${name}`);
        params[name] = p.str(detail(patch[name]), 50);
      }
      if (sets.length > 0) await execute(tx, `UPDATE dbo.masraf_kategorileri SET ${sets.join(', ')} WHERE id = @id`, params);
      const after = (await getCategory(tx, id)) as Kategori;
      const changes = [
        after.ad !== before.ad ? ` → ${after.ad}` : '',
        ...DETAILS.filter(([name]) => after[name] !== before[name]).map(([name]) => `, ${name} ${before[name] ?? '-'} → ${after[name] ?? '-'}`),
        after.aktif !== before.aktif ? (after.aktif ? ', aktif edildi' : ', pasifleştirildi') : '',
      ];
      await audit(tx, actor.id, 'kategori_guncellendi', `${before.ad}${changes.join('')}`);
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
}

/** Deletes a category no form uses, and the rules whose condition it is. 409 kullaniliyor otherwise. */
export async function deleteCategory(db: Db, actor: Actor, id: number): Promise<void> {
  try {
    await transaction(db, async (tx) => {
      await lockList(tx, LOCK);
      // A rule being written for this category holds its row (UPDLOCK) until it commits; waiting for it
      // here means its rule is deleted below, or it finds the category gone.
      await queryOne(tx, 'SELECT id FROM dbo.masraf_kategorileri WITH (UPDLOCK, ROWLOCK) WHERE id = @id', { id: p.int(id) });
      const before = await getCategory(tx, id);
      if (before === null) throw notFound('Kategori bulunamadı.');
      const used = await queryOne(tx, 'SELECT TOP (1) 1 AS x FROM dbo.masraf_formlari WHERE kategori_id = @id', { id: p.int(id) });
      if (used !== null) throw inUse();
      const rules = await deleteRulesOf(tx, 'kategori', [id]);
      await execute(tx, 'DELETE FROM dbo.masraf_kategorileri WHERE id = @id', { id: p.int(id) });
      await audit(tx, actor.id, 'kategori_silindi', `${before.ad}${rules > 0 ? ` (${rules} zorunluluk kuralı da silindi)` : ''}`);
    });
  } catch (err) {
    if (sqlErrorNumber(err) === SQL_ERROR.foreignKey) throw inUse();
    throw err;
  }
}
