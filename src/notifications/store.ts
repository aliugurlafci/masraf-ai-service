// Notifications in the database: written in the caller's transaction, listed and marked read by their
// owner (docs/onay-sistemi.md, sections 6 and 7).
import { execute, iso, p, query, queryOne, type Executor } from '../db/sql.ts';
import { planNotifications, wantsMail, type BildirimTuru, type NotificationEvent } from './events.ts';
import { renderNotificationMail } from './mail-templates.ts';

export interface NotifySettings {
  /** MAIL_GONDERIM=smtp. When false, mails are written as skipped (atlandi) and never sent. */
  readonly mailEnabled: boolean;
  /** Panel address for links in mails; null = no links. */
  readonly appUrl: string | null;
}

export const NO_MAIL: NotifySettings = { mailEnabled: false, appUrl: null };

export interface Bildirim {
  readonly id: number;
  readonly tur: BildirimTuru;
  readonly baslik: string;
  readonly mesaj: string;
  readonly form: { readonly id: number; readonly baslik: string } | null;
  readonly olusturma: string;
  readonly okundu: boolean;
}

/**
 * Writes the notifications of `event` and queues their mails, on `ex` (the transaction of the action,
 * so a rolled-back action leaves nothing behind). `actorId` is never notified of their own action.
 */
export async function notify(ex: Executor, event: NotificationEvent, actorId: number | null, settings: NotifySettings): Promise<void> {
  const planned = planNotifications(event, actorId);
  if (planned.length === 0) return;
  const ids = planned.map((n) => n.kullaniciId);
  const users = await query<{ id: number; ad_soyad: string; eposta: string; aktif: boolean; mail_bildirim: boolean }>(
    ex,
    `SELECT id, ad_soyad, eposta, aktif, mail_bildirim FROM dbo.kullanicilar WHERE id IN (${ids.map((_, i) => `@u${i}`).join(', ')})`,
    Object.fromEntries(ids.map((id, i) => [`u${i}`, p.int(id)])),
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const n of planned) {
    const user = byId.get(n.kullaniciId);
    if (user === undefined) continue;
    // The form title is kept as it is now: the list never shows a later title.
    await execute(ex, 'INSERT INTO dbo.bildirimler (kullanici_id, tur, form_id, form_baslik, baslik, mesaj) VALUES (@u, @t, @f, @fb, @b, @m)', {
      u: p.int(n.kullaniciId),
      t: p.ascii(n.tur, 20),
      f: p.int(event.form.id),
      fb: p.str(event.form.baslik.slice(0, 120), 120),
      b: p.str(n.baslik.slice(0, 200), 200),
      m: p.str(n.mesaj.slice(0, 1000), 1000),
    });
    if (!wantsMail({ aktif: user.aktif, mailBildirim: user.mail_bildirim })) continue;
    const mail = renderNotificationMail({ alici: user.ad_soyad, baslik: n.baslik, mesaj: n.mesaj, form: event.form, appUrl: settings.appUrl });
    await execute(
      ex,
      `INSERT INTO dbo.eposta_kutusu (alici_id, adres, konu, metin, html, ek_turu, form_id, durum, sonraki_deneme)
       VALUES (@u, @a, @k, @t, @h, @e, @f, @d, CASE WHEN @d = 'bekliyor' THEN SYSUTCDATETIME() END)`,
      {
        u: p.int(user.id),
        a: p.str(user.eposta, 254),
        k: p.str(mail.konu, 200),
        t: p.text(mail.metin),
        h: p.text(mail.html),
        e: p.ascii(n.ek, 16),
        f: p.int(event.form.id),
        d: p.ascii(settings.mailEnabled ? 'bekliyor' : 'atlandi', 12),
      },
    );
  }
}

/** Ids of the active accountants, who are told when a form waits for payment. */
export async function activeAccountants(ex: Executor): Promise<number[]> {
  const rows = await query<{ id: number }>(ex, `SELECT id FROM dbo.kullanicilar WHERE rol = 'muhasebe' AND aktif = 1 ORDER BY id`);
  return rows.map((r) => r.id);
}

interface Row {
  id: number;
  tur: BildirimTuru;
  baslik: string;
  mesaj: string;
  form_id: number | null;
  form_baslik: string | null;
  olusturma: Date;
  okunma: Date | null;
}

export async function listNotifications(
  ex: Executor,
  userId: number,
  q: { readonly okunmamis: boolean; readonly sayfa: number; readonly adet: number },
): Promise<{ kayitlar: Bildirim[]; toplam: number; okunmamis: number; sayfa: number; adet: number }> {
  const filter = q.okunmamis ? 'AND b.okunma IS NULL' : '';
  const params = { u: p.int(userId), off: p.int((q.sayfa - 1) * q.adet), n: p.int(q.adet) };
  const [rows, counts] = await Promise.all([
    query<Row>(
      ex,
      `SELECT b.id, b.tur, b.baslik, b.mesaj, b.form_id, b.form_baslik, b.olusturma, b.okunma
       FROM dbo.bildirimler b
       WHERE b.kullanici_id = @u ${filter}
       ORDER BY b.olusturma DESC, b.id DESC OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`,
      params,
    ),
    queryOne<{ toplam: number; okunmamis: number | null }>(
      ex,
      `SELECT COUNT(*) AS toplam, SUM(CASE WHEN okunma IS NULL THEN 1 ELSE 0 END) AS okunmamis
       FROM dbo.bildirimler b WHERE kullanici_id = @u ${filter}`,
      params,
    ),
  ]);
  const okunmamis = q.okunmamis ? (counts?.toplam ?? 0) : await unreadCount(ex, userId);
  return {
    kayitlar: rows.map((r) => ({
      id: r.id,
      tur: r.tur,
      baslik: r.baslik,
      mesaj: r.mesaj,
      form: r.form_id === null ? null : { id: r.form_id, baslik: r.form_baslik ?? '' },
      olusturma: iso(r.olusturma) ?? '',
      okundu: r.okunma !== null,
    })),
    toplam: counts?.toplam ?? 0,
    okunmamis,
    sayfa: q.sayfa,
    adet: q.adet,
  };
}

export async function unreadCount(ex: Executor, userId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(ex, 'SELECT COUNT(*) AS n FROM dbo.bildirimler WHERE kullanici_id = @u AND okunma IS NULL', { u: p.int(userId) });
  return row?.n ?? 0;
}

/** Marks one of the user's notifications read; false when it is not theirs or does not exist. */
export async function markRead(ex: Executor, userId: number, id: number): Promise<boolean> {
  const found = await queryOne<{ x: number }>(ex, 'SELECT 1 AS x FROM dbo.bildirimler WHERE id = @id AND kullanici_id = @u', { id: p.int(id), u: p.int(userId) });
  if (found === null) return false;
  await execute(ex, 'UPDATE dbo.bildirimler SET okunma = SYSUTCDATETIME() WHERE id = @id AND kullanici_id = @u AND okunma IS NULL', { id: p.int(id), u: p.int(userId) });
  return true;
}

export async function markAllRead(ex: Executor, userId: number): Promise<void> {
  await execute(ex, 'UPDATE dbo.bildirimler SET okunma = SYSUTCDATETIME() WHERE kullanici_id = @u AND okunma IS NULL', { u: p.int(userId) });
}
