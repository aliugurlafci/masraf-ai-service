import { audit } from '../db/audit.ts';
import { execute, isUniqueViolation, p, query, queryOne, transaction, type Db, type Executor, type Param } from '../db/sql.ts';
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
}

export interface CategoryPatch {
  readonly ad?: string | undefined;
  readonly simge?: Simge | undefined;
  readonly aktif?: boolean | undefined;
  readonly sira?: number | undefined;
}

const SELECT = 'SELECT id, ad, simge, aktif, sira FROM dbo.masraf_kategorileri';
const taken = (): Error => conflict('kategori_var', 'Bu adla bir kategori zaten var.');

export async function listCategories(db: Db, includeInactive: boolean): Promise<Kategori[]> {
  return query<Kategori>(db, `${SELECT} ${includeInactive ? '' : 'WHERE aktif = 1'} ORDER BY sira, ad`);
}

export async function getCategory(ex: Executor, id: number): Promise<Kategori | null> {
  return queryOne<Kategori>(ex, `${SELECT} WHERE id = @id`, { id: p.int(id) });
}

export async function createCategory(db: Db, actor: Actor, input: { ad: string; simge?: Simge | undefined }): Promise<Kategori> {
  try {
    return await transaction(db, async (tx) => {
      const row = await queryOne<{ id: number }>(
        tx,
        `INSERT INTO dbo.masraf_kategorileri (ad, simge, sira)
         OUTPUT inserted.id
         VALUES (@ad, @s, (SELECT ISNULL(MAX(sira), 0) + 1 FROM dbo.masraf_kategorileri))`,
        { ad: p.str(input.ad.trim(), 60), s: p.ascii(input.simge ?? 'diger', 16) },
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
      if (sets.length > 0) await execute(tx, `UPDATE dbo.masraf_kategorileri SET ${sets.join(', ')} WHERE id = @id`, params);
      const after = (await getCategory(tx, id)) as Kategori;
      await audit(tx, actor.id, 'kategori_guncellendi', `${before.ad}${after.ad !== before.ad ? ` → ${after.ad}` : ''}${after.aktif !== before.aktif ? (after.aktif ? ', aktif edildi' : ', pasifleştirildi') : ''}`);
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
}
