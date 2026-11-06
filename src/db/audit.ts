import { execute, iso, p, query, type Db, type Executor } from './sql.ts';

export interface AuditEntry {
  readonly id: number;
  readonly islem: string;
  readonly ayrinti: string | null;
  readonly kullanici: { readonly id: number; readonly adSoyad: string } | null;
  readonly tarih: string;
}

/** Writes one line of the administrators' audit log, inside the caller's transaction when given one. */
export async function audit(ex: Executor, kullaniciId: number | null, islem: string, ayrinti: string | null): Promise<void> {
  await execute(ex, 'INSERT INTO dbo.denetim_kayitlari (kullanici_id, islem, ayrinti) VALUES (@k, @i, @a)', {
    k: p.int(kullaniciId),
    i: p.ascii(islem, 40),
    a: p.str(ayrinti === null ? null : ayrinti.slice(0, 1000), 1000),
  });
}

interface AuditRow {
  id: number | string;
  islem: string;
  ayrinti: string | null;
  kullanici_id: number | null;
  ad_soyad: string | null;
  tarih: Date;
}

export async function listAudit(db: Db, limit: number): Promise<AuditEntry[]> {
  const rows = await query<AuditRow>(
    db,
    `SELECT TOP (@n) d.id, d.islem, d.ayrinti, d.kullanici_id, k.ad_soyad, d.tarih
     FROM dbo.denetim_kayitlari d LEFT JOIN dbo.kullanicilar k ON k.id = d.kullanici_id
     ORDER BY d.tarih DESC, d.id DESC`,
    { n: p.int(limit) },
  );
  return rows.map((r) => ({
    id: Number(r.id),
    islem: r.islem,
    ayrinti: r.ayrinti,
    kullanici: r.kullanici_id === null ? null : { id: r.kullanici_id, adSoyad: r.ad_soyad ?? '' },
    tarih: iso(r.tarih) ?? '',
  }));
}
