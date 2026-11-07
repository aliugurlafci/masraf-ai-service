// Approval reminders (docs/onay-sistemi.md, section 7): once a day after HATIRLATMA_SAATI (the server's
// local time), every step that has waited longer than HATIRLATMA_BEKLEME_SAAT hours and was not reminded
// that day gets one notification and mail. son_hatirlatma keeps it to once a day per step, across
// restarts and server processes.
import { p, query, transaction, type Db } from '../db/sql.ts';
import type { ReminderSettings } from '../config.ts';
import { notify, type NotifySettings } from './store.ts';

/** The local calendar day of `d`, YYYY-MM-DD. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const startOfLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whether the daily run is due: reminders on, the time of day reached, and not run yet today. */
export function reminderDue(now: Date, settings: ReminderSettings, lastRunDay: string | null): boolean {
  if (settings.waitHours === 0) return false;
  if (lastRunDay === localDay(now)) return false;
  return now.getHours() * 60 + now.getMinutes() >= settings.hour * 60 + settings.minute;
}

/**
 * Reminds the approver of every step due at `now`; returns how many were reminded. A step waits from
 * the form's sending or the previous decision of its round, whichever is later.
 */
export async function runReminders(db: Db, now: Date, settings: ReminderSettings, mail: NotifySettings): Promise<number> {
  if (settings.waitHours === 0) return 0;
  const due = await query<{ id: number }>(
    db,
    `SELECT o.id
     FROM dbo.form_onaylari o
     JOIN dbo.masraf_formlari f ON f.id = o.form_id AND f.tur = o.tur
     OUTER APPLY (SELECT MAX(x.karar_tarihi) AS son FROM dbo.form_onaylari x
                  WHERE x.form_id = o.form_id AND x.tur = o.tur AND x.sira < o.sira) prev
     WHERE o.durum = 'bekliyor' AND f.durum = 'onayda'
       AND (o.son_hatirlatma IS NULL OR o.son_hatirlatma < @day)
       AND (CASE WHEN prev.son > f.gonderim THEN prev.son ELSE f.gonderim END) <= @cutoff
     ORDER BY o.id`,
    { day: p.time(startOfLocalDay(now)), cutoff: p.time(new Date(now.getTime() - settings.waitHours * 3_600_000)) },
  );
  let reminded = 0;
  for (const step of due) if (await remindStep(db, step.id, now, settings, mail)) reminded++;
  return reminded;
}

/**
 * Reminds one step, in one transaction: marks it and takes its approver and form as they are now, so
 * a step handed to someone else, decided or withdrawn since it was found goes to the right person or
 * to nobody. Returns false when the step no longer waits or was already reminded today.
 */
export async function remindStep(db: Db, stepId: number, now: Date, settings: ReminderSettings, mail: NotifySettings): Promise<boolean> {
  return transaction(db, async (tx) => {
    const marked = await query<{
      onayci_id: number;
      form_id: number;
      baslik: string;
      olusturan_id: number;
      olusturan_ad: string;
      tutar: number;
      para_birimi: string;
    }>(
      tx,
      `UPDATE o SET son_hatirlatma = @now
       OUTPUT inserted.onayci_id, f.id AS form_id, f.baslik, f.olusturan_id, u.ad_soyad AS olusturan_ad, f.tutar, f.para_birimi
       FROM dbo.form_onaylari o
       JOIN dbo.masraf_formlari f ON f.id = o.form_id AND f.tur = o.tur
       JOIN dbo.kullanicilar u ON u.id = f.olusturan_id
       WHERE o.id = @id AND o.durum = 'bekliyor' AND f.durum = 'onayda'
         AND (o.son_hatirlatma IS NULL OR o.son_hatirlatma < @day)`,
      { id: p.int(stepId), now: p.time(now), day: p.time(startOfLocalDay(now)) },
    );
    const s = marked[0];
    if (s === undefined) return false;
    await notify(
      tx,
      {
        kind: 'hatirlatma',
        form: { id: s.form_id, baslik: s.baslik, sahip: { id: s.olusturan_id, adSoyad: s.olusturan_ad }, tutar: Number(s.tutar), paraBirimi: s.para_birimi, durum: 'onayda' },
        onayciId: s.onayci_id,
        saat: settings.waitHours,
      },
      null,
      mail,
    );
    return true;
  });
}

export interface ReminderJob {
  /** Runs the reminders when they are due now; returns how many steps were reminded. */
  runOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createReminderJob(opts: {
  readonly db: Db;
  readonly settings: ReminderSettings;
  readonly mail: NotifySettings;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly log?: (line: string) => void;
}): ReminderJob {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.info(line));
  let lastRunDay: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  let stopped = false;

  async function runOnce(): Promise<number> {
    const at = now();
    if (!reminderDue(at, opts.settings, lastRunDay)) return 0;
    const n = await runReminders(opts.db, at, opts.settings, opts.mail);
    lastRunDay = localDay(at);
    if (n > 0) log(`${n} onay adımı için hatırlatma gönderildi.`);
    return n;
  }

  const tick = (): void => {
    if (stopped) return;
    running = runOnce()
      .catch((err: unknown) => log(`hatırlatma çalışamadı: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = null;
        if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 60_000);
      });
  };

  return {
    runOnce,
    start() {
      stopped = false;
      if (opts.settings.waitHours > 0 && timer === null && running === null) timer = setTimeout(tick, 0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (running !== null) await running;
    },
  };
}
