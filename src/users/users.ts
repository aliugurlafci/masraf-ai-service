import { audit } from '../db/audit.ts';
import { execute, isUniqueViolation, iso, p, query, queryOne, transaction, type Db, type Executor, type Param } from '../db/sql.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import { ROLES, type Actor, type Rol } from '../expenses/rules.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import { stepBand, type Strateji } from '../approval/flow.ts';
import type { AkisOzet } from '../approval/flow-store.ts';
import type { FirstAdmin } from '../config.ts';

/** One flow the user approves in: their order, approval limit and the amounts that reach them there. */
export interface OnayciYeri {
  readonly akis: { readonly id: number; readonly ad: string; readonly strateji: Strateji };
  readonly sira: number;
  /** Largest amount they give the last approval for; null = no limit. */
  readonly limit: number | null;
  /** Expenses of these amounts (inclusive) come to them; null upper limit = no limit. */
  readonly altLimit: number;
  readonly ustLimit: number | null;
}

export interface Kullanici {
  readonly id: number;
  readonly eposta: string;
  readonly adSoyad: string;
  readonly rol: Rol;
  readonly departman: string | null;
  readonly aktif: boolean;
  readonly sifreDegismeli: boolean;
  readonly olusturma: string;
  readonly sonGiris: string | null;
  /** Notifications also come as mail (the user's own choice; in-app notifications cannot be turned off). */
  readonly mailBildirim: boolean;
  /** The flow the user is assigned to; null = follows the default flow. */
  readonly onayAkisiId: number | null;
  /** The flow the user's expenses go to now. Always set while a default flow exists (the migration creates one). */
  readonly onayAkisi: AkisOzet | null;
  /** The flows the user approves in, the default first, then by name. */
  readonly onaycilik: readonly OnayciYeri[];
}

export interface NewUser {
  readonly eposta: string;
  readonly adSoyad: string;
  readonly rol: Rol;
  readonly departman?: string | null | undefined;
  readonly sifre: string;
  readonly onayAkisiId?: number | null | undefined;
}

export interface UserPatch {
  readonly eposta?: string | undefined;
  readonly adSoyad?: string | undefined;
  readonly rol?: Rol | undefined;
  readonly departman?: string | null | undefined;
  readonly aktif?: boolean | undefined;
  readonly onayAkisiId?: number | null | undefined;
}

interface UserRow {
  id: number;
  eposta: string;
  ad_soyad: string;
  rol: Rol;
  departman: string | null;
  aktif: boolean;
  sifre_degismeli: boolean;
  olusturma: Date;
  son_giris: Date | null;
  mail_bildirim: boolean;
  onay_akisi_id: number | null;
  akis_id: number | null;
  akis_ad: string | null;
  akis_varsayilan: boolean | null;
}

interface PlaceRow {
  onayci_id: number;
  akis_id: number;
  akis_ad: string;
  strateji: Strateji;
  sira: number;
  onay_limiti: number | null;
}

export const normalizeEmail = (eposta: string): string => eposta.trim().toLowerCase();

const USER_COLUMNS = `k.id, k.eposta, k.ad_soyad, k.rol, k.departman, k.aktif, k.sifre_degismeli, k.olusturma, k.son_giris,
  k.mail_bildirim, k.onay_akisi_id, ea.id AS akis_id, ea.ad AS akis_ad, ea.varsayilan AS akis_varsayilan`;
// The effective flow: the assigned one, otherwise the default.
const USER_FROM = `FROM dbo.kullanicilar k
  OUTER APPLY (SELECT TOP (1) a.id, a.ad, a.varsayilan FROM dbo.onay_akislari a
               WHERE a.id = k.onay_akisi_id OR (k.onay_akisi_id IS NULL AND a.varsayilan = 1)) ea`;
const USER_SELECT = `SELECT ${USER_COLUMNS} ${USER_FROM}`;

function toUser(r: UserRow, places: readonly OnayciYeri[]): Kullanici {
  return {
    id: r.id,
    eposta: r.eposta,
    adSoyad: r.ad_soyad,
    rol: r.rol,
    departman: r.departman,
    aktif: r.aktif,
    sifreDegismeli: r.sifre_degismeli,
    olusturma: iso(r.olusturma) ?? '',
    sonGiris: iso(r.son_giris),
    mailBildirim: r.mail_bildirim,
    onayAkisiId: r.onay_akisi_id,
    onayAkisi: r.akis_id === null ? null : { id: r.akis_id, ad: r.akis_ad ?? '', varsayilan: r.akis_varsayilan === true },
    onaycilik: places,
  };
}

/** Where each user approves; `userId` narrows it to one user. The amounts that reach a step depend on the steps around it. */
async function approverPlaces(ex: Executor, userId?: number): Promise<Map<number, OnayciYeri[]>> {
  const rows = await query<PlaceRow>(
    ex,
    `SELECT s.onayci_id, a.id AS akis_id, a.ad AS akis_ad, a.strateji, s.sira, s.onay_limiti
     FROM dbo.onay_adimlari s JOIN dbo.onay_akislari a ON a.id = s.akis_id
     ${userId === undefined ? '' : 'WHERE s.akis_id IN (SELECT akis_id FROM dbo.onay_adimlari WHERE onayci_id = @u)'}
     ORDER BY a.varsayilan DESC, a.ad, a.id, s.sira`,
    userId === undefined ? {} : { u: p.int(userId) },
  );
  const flows = new Map<number, PlaceRow[]>();
  for (const r of rows) flows.set(r.akis_id, [...(flows.get(r.akis_id) ?? []), r]);
  const out = new Map<number, OnayciYeri[]>();
  for (const steps of flows.values()) {
    const limits = steps.map((s) => ({ onayciId: s.onayci_id, limit: s.onay_limiti === null ? null : Number(s.onay_limiti) }));
    steps.forEach((r, i) => {
      if (userId !== undefined && r.onayci_id !== userId) return;
      const band = stepBand(r.strateji, limits, i);
      const place: OnayciYeri = { akis: { id: r.akis_id, ad: r.akis_ad, strateji: r.strateji }, sira: r.sira, limit: limits[i]?.limit ?? null, ...band };
      out.set(r.onayci_id, [...(out.get(r.onayci_id) ?? []), place]);
    });
  }
  return out;
}

async function oneUser(ex: Executor, row: UserRow | null): Promise<Kullanici | null> {
  if (row === null) return null;
  return toUser(row, (await approverPlaces(ex, row.id)).get(row.id) ?? []);
}

const likePattern = (q: string): string => `%${q.replace(/[%_[]/g, '[$&]')}%`;

export async function listUsers(db: Db, filter: { q?: string | undefined; aktif?: boolean | undefined } = {}): Promise<Kullanici[]> {
  const where: string[] = [];
  const params: Record<string, Param> = {};
  if (filter.aktif !== undefined) {
    where.push('k.aktif = @aktif');
    params.aktif = p.bit(filter.aktif);
  }
  const q = filter.q?.trim();
  if (q !== undefined && q !== '') {
    where.push('(k.ad_soyad LIKE @q OR k.eposta LIKE @q OR k.departman LIKE @q)');
    params.q = p.str(likePattern(q), 300);
  }
  const rows = await query<UserRow>(
    db,
    `${USER_SELECT} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY k.ad_soyad, k.id`,
    params,
  );
  const places = await approverPlaces(db);
  return rows.map((r) => toUser(r, places.get(r.id) ?? []));
}

export async function getUser(ex: Executor, id: number): Promise<Kullanici | null> {
  return oneUser(ex, await queryOne<UserRow>(ex, `${USER_SELECT} WHERE k.id = @id`, { id: p.int(id) }));
}

export async function findLoginUser(db: Db, eposta: string): Promise<{ kullanici: Kullanici; sifreOzeti: string } | null> {
  const row = await queryOne<UserRow & { sifre_ozeti: string }>(
    db,
    `SELECT ${USER_COLUMNS}, k.sifre_ozeti ${USER_FROM} WHERE k.eposta = @e`,
    { e: p.str(normalizeEmail(eposta), 254) },
  );
  const kullanici = await oneUser(db, row);
  return row === null || kullanici === null ? null : { kullanici, sifreOzeti: row.sifre_ozeti };
}

/** Rejects an assignment to a flow that does not exist. Call while holding the flow lock. */
async function checkFlowExists(ex: Executor, flowId: number | null | undefined): Promise<void> {
  if (flowId === null || flowId === undefined) return;
  const hit = await queryOne(ex, 'SELECT TOP (1) 1 AS x FROM dbo.onay_akislari WHERE id = @id', { id: p.int(flowId) });
  if (hit === null) {
    const msg = 'Onay akışı bulunamadı.';
    throw new HttpError(400, 'gecersiz_istek', msg, { alanlar: { onayAkisiId: msg } });
  }
}

function checkPassword(sifre: string, minLength: number, field = 'sifre'): void {
  const problem = passwordProblem(sifre, minLength);
  if (problem !== null) throw new HttpError(400, 'gecersiz_istek', problem, { alanlar: { [field]: problem } });
}

const emailTaken = (): HttpError => conflict('eposta_kullaniliyor', 'Bu e-posta adresiyle kayıtlı bir kullanıcı var.');

export async function createUser(db: Db, actor: Actor, input: NewUser, passwordMinLength: number): Promise<Kullanici> {
  checkPassword(input.sifre, passwordMinLength);
  const hash = await hashPassword(input.sifre);
  try {
    return await transaction(db, async (tx) => {
      const flowId = input.onayAkisiId ?? null;
      if (flowId !== null) {
        await lockFlow(tx); // the flow cannot be deleted under us
        await checkFlowExists(tx, flowId);
      }
      const row = await queryOne<{ id: number }>(
        tx,
        `INSERT INTO dbo.kullanicilar (eposta, ad_soyad, rol, departman, sifre_ozeti, sifre_degismeli, onay_akisi_id)
         OUTPUT inserted.id VALUES (@e, @ad, @rol, @dep, @h, 1, @akis)`,
        {
          e: p.str(normalizeEmail(input.eposta), 254),
          ad: p.str(input.adSoyad.trim(), 120),
          rol: p.ascii(input.rol, 16),
          dep: p.str(input.departman?.trim() || null, 80),
          h: p.ascii(hash, 256),
          akis: p.int(flowId),
        },
      );
      if (row === null) throw new Error('kullanıcı eklenemedi');
      const user = (await getUser(tx, row.id)) as Kullanici;
      await audit(
        tx,
        actor.id,
        'kullanici_olusturuldu',
        `${user.adSoyad} <${user.eposta}>, rol: ${user.rol}, onay akışı: ${flowLabel(user)}`,
      );
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }
}

/** Approval steps the user still has to decide on, in forms waiting for approval. */
async function openApprovals(ex: Executor, userId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    ex,
    `SELECT COUNT(*) AS n FROM dbo.form_onaylari o
     JOIN dbo.masraf_formlari f ON f.id = o.form_id AND f.tur = o.tur
     WHERE o.onayci_id = @id AND o.durum IN ('bekliyor', 'sirada') AND f.durum = 'onayda'`,
    { id: p.int(userId) },
  );
  return row?.n ?? 0;
}

/** Serialises changes that must see a stable approval flow (flow edits, deactivating users). */
export async function lockFlow(ex: Executor): Promise<void> {
  await execute(ex, `EXEC sp_getapplock @Resource = N'masraf_onay_akisi', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 15000`);
}

export async function updateUser(db: Db, actor: Actor, id: number, patch: UserPatch): Promise<Kullanici> {
  try {
    return await transaction(db, async (tx) => {
      await lockFlow(tx);
      const before = await getUser(tx, id);
      if (before === null) throw notFound('Kullanıcı bulunamadı.');
      const deactivating = patch.aktif === false && before.aktif;
      const leavingAdmin = before.rol === 'yonetici' && before.aktif && (deactivating || (patch.rol !== undefined && patch.rol !== 'yonetici'));
      if (deactivating && id === actor.id) throw conflict('kendi_hesabi', 'Kendi hesabınızı pasifleştiremezsiniz.');
      if (leavingAdmin) {
        const others = await queryOne<{ n: number }>(
          tx,
          `SELECT COUNT(*) AS n FROM dbo.kullanicilar WITH (UPDLOCK, HOLDLOCK) WHERE rol = 'yonetici' AND aktif = 1 AND id <> @id`,
          { id: p.int(id) },
        );
        if ((others?.n ?? 0) === 0) throw conflict('son_yonetici', 'En az bir aktif yönetici kalmalıdır.');
      }
      if (deactivating) {
        if (before.onaycilik.length > 0) {
          const where = before.onaycilik.map((o) => `${o.akis.ad} (${o.sira}. sıra)`).join(', ');
          const flows = before.onaycilik.length === 1 ? 'bu akıştan' : 'bu akışlardan';
          throw conflict('onay_akisinda', `${before.adSoyad} onay akışında onaycı: ${where}. Önce ${flows} çıkarın.`);
        }
        const open = await openApprovals(tx, id);
        if (open > 0) {
          throw conflict('bekleyen_onay_var', `${before.adSoyad} kullanıcısının karar vermediği ${open} onay adımı var. Önce bu onayları başka bir kullanıcıya devredin.`);
        }
      }
      const sets: string[] = ['guncelleme = SYSUTCDATETIME()'];
      const params: Record<string, Param> = { id: p.int(id) };
      if (patch.eposta !== undefined) {
        sets.push('eposta = @e');
        params.e = p.str(normalizeEmail(patch.eposta), 254);
      }
      if (patch.adSoyad !== undefined) {
        sets.push('ad_soyad = @ad');
        params.ad = p.str(patch.adSoyad.trim(), 120);
      }
      if (patch.rol !== undefined) {
        sets.push('rol = @rol');
        params.rol = p.ascii(patch.rol, 16);
      }
      if (patch.departman !== undefined) {
        sets.push('departman = @dep');
        params.dep = p.str(patch.departman?.trim() || null, 80);
      }
      if (patch.aktif !== undefined) {
        sets.push('aktif = @aktif');
        params.aktif = p.bit(patch.aktif);
      }
      if (patch.onayAkisiId !== undefined) {
        await checkFlowExists(tx, patch.onayAkisiId);
        sets.push('onay_akisi_id = @akis');
        params.akis = p.int(patch.onayAkisiId);
      }
      await execute(tx, `UPDATE dbo.kullanicilar SET ${sets.join(', ')} WHERE id = @id`, params);
      if (deactivating) await execute(tx, 'DELETE FROM dbo.oturumlar WHERE kullanici_id = @id', { id: p.int(id) });
      const after = (await getUser(tx, id)) as Kullanici;
      const changes = describeChanges(before, after);
      if (changes !== '') await audit(tx, actor.id, 'kullanici_guncellendi', `${after.adSoyad}: ${changes}`);
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }
}

function describeChanges(a: Kullanici, b: Kullanici): string {
  const out: string[] = [];
  if (a.eposta !== b.eposta) out.push(`e-posta ${a.eposta} → ${b.eposta}`);
  if (a.adSoyad !== b.adSoyad) out.push(`ad ${a.adSoyad} → ${b.adSoyad}`);
  if (a.rol !== b.rol) out.push(`rol ${a.rol} → ${b.rol}`);
  if (a.departman !== b.departman) out.push(`departman ${a.departman ?? '-'} → ${b.departman ?? '-'}`);
  if (a.aktif !== b.aktif) out.push(b.aktif ? 'aktif edildi' : 'pasifleştirildi');
  if (a.onayAkisiId !== b.onayAkisiId) out.push(`onay akışı ${flowLabel(a)} → ${flowLabel(b)}`);
  return out.join(', ');
}

/** "Satış", or "varsayılan (Genel)" for a user without an assignment. */
function flowLabel(u: Kullanici): string {
  const name = u.onayAkisi?.ad ?? '-';
  return u.onayAkisiId === null ? `varsayılan (${name})` : name;
}

/** An administrator sets a new password: the user must change it at next login, open sessions end. */
export async function resetPassword(db: Db, actor: Actor, id: number, yeniSifre: string, passwordMinLength: number): Promise<void> {
  checkPassword(yeniSifre, passwordMinLength, 'yeniSifre');
  const hash = await hashPassword(yeniSifre);
  await transaction(db, async (tx) => {
    const user = await getUser(tx, id);
    if (user === null) throw notFound('Kullanıcı bulunamadı.');
    await execute(tx, 'UPDATE dbo.kullanicilar SET sifre_ozeti = @h, sifre_degismeli = 1, guncelleme = SYSUTCDATETIME() WHERE id = @id', {
      h: p.ascii(hash, 256),
      id: p.int(id),
    });
    await execute(tx, 'DELETE FROM dbo.oturumlar WHERE kullanici_id = @id', { id: p.int(id) });
    await audit(tx, actor.id, 'sifre_sifirlandi', user.adSoyad);
  });
}

/** The user changes their own password; every other session of theirs ends. */
export async function changeOwnPassword(
  db: Db,
  userId: number,
  mevcutSifre: string,
  yeniSifre: string,
  keepSession: string | null,
  passwordMinLength: number,
): Promise<void> {
  const row = await queryOne<{ sifre_ozeti: string }>(db, 'SELECT sifre_ozeti FROM dbo.kullanicilar WHERE id = @id', { id: p.int(userId) });
  if (row === null) throw notFound('Kullanıcı bulunamadı.');
  if (!(await verifyPassword(mevcutSifre, row.sifre_ozeti))) {
    throw new HttpError(400, 'hatali_sifre', 'Mevcut şifre hatalı.', { alanlar: { mevcutSifre: 'Mevcut şifre hatalı.' } });
  }
  checkPassword(yeniSifre, passwordMinLength, 'yeniSifre');
  if (mevcutSifre === yeniSifre) {
    const msg = 'Yeni şifre mevcut şifreden farklı olmalıdır.';
    throw new HttpError(400, 'gecersiz_istek', msg, { alanlar: { yeniSifre: msg } });
  }
  const hash = await hashPassword(yeniSifre);
  await transaction(db, async (tx) => {
    await execute(tx, 'UPDATE dbo.kullanicilar SET sifre_ozeti = @h, sifre_degismeli = 0, guncelleme = SYSUTCDATETIME() WHERE id = @id', {
      h: p.ascii(hash, 256),
      id: p.int(userId),
    });
    await execute(tx, 'DELETE FROM dbo.oturumlar WHERE kullanici_id = @id AND token_ozeti <> ISNULL(@keep, \'\')', {
      id: p.int(userId),
      keep: p.ascii(keepSession, 64),
    });
  });
}

export type FirstAdminResult = 'olusturuldu' | 'kullanici_var' | 'ayar_yok';

/**
 * On an empty database, creates the first administrator from .env and makes them the only approver
 * (0 – no limit) of the default flow, so it is never empty. Does nothing once any user exists.
 */
export async function ensureFirstAdmin(db: Db, admin: FirstAdmin | null): Promise<FirstAdminResult> {
  const any = await queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM dbo.kullanicilar');
  if ((any?.n ?? 0) > 0) return 'kullanici_var';
  if (admin === null) return 'ayar_yok';
  const hash = await hashPassword(admin.sifre);
  return transaction(db, async (tx) => {
    await lockFlow(tx);
    const again = await queryOne<{ n: number }>(tx, 'SELECT COUNT(*) AS n FROM dbo.kullanicilar WITH (UPDLOCK, HOLDLOCK)');
    if ((again?.n ?? 0) > 0) return 'kullanici_var';
    const row = await queryOne<{ id: number }>(
      tx,
      `INSERT INTO dbo.kullanicilar (eposta, ad_soyad, rol, sifre_ozeti) OUTPUT inserted.id VALUES (@e, @ad, 'yonetici', @h)`,
      { e: p.str(admin.eposta, 254), ad: p.str(admin.adSoyad, 120), h: p.ascii(hash, 256) },
    );
    if (row === null) throw new Error('ilk yönetici eklenemedi');
    const flow = await queryOne<{ id: number; ad: string }>(tx, 'SELECT id, ad FROM dbo.onay_akislari WHERE varsayilan = 1');
    if (flow === null) throw new Error('varsayılan onay akışı yok');
    await execute(tx, 'INSERT INTO dbo.onay_adimlari (akis_id, sira, onayci_id, onay_limiti) VALUES (@f, 1, @id, NULL)', {
      f: p.int(flow.id),
      id: p.int(row.id),
    });
    await execute(tx, 'UPDATE dbo.onay_akislari SET guncelleme = SYSUTCDATETIME(), guncelleyen_id = @id WHERE id = @f', {
      f: p.int(flow.id),
      id: p.int(row.id),
    });
    await audit(tx, row.id, 'ilk_yonetici', `${admin.adSoyad} <${admin.eposta}> oluşturuldu ve ${flow.ad} onay akışına eklendi.`);
    return 'olusturuldu';
  });
}

export const isRole = (v: string): v is Rol => (ROLES as readonly string[]).includes(v);

/** The user's own mail preference (PUT /api/ben/tercihler). */
export async function setMailPreference(db: Db, userId: number, mailBildirim: boolean): Promise<Kullanici> {
  await execute(db, 'UPDATE dbo.kullanicilar SET mail_bildirim = @m, guncelleme = SYSUTCDATETIME() WHERE id = @id', { id: p.int(userId), m: p.bit(mailBildirim) });
  const user = await getUser(db, userId);
  if (user === null) throw notFound('Kullanıcı bulunamadı.');
  return user;
}
