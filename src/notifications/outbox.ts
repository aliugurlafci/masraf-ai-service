// The outgoing mail box (docs/onay-sistemi.md, section 7): a job inside the server sends the queued
// mails, retries failures at growing intervals and gives up after MAIL_DENEME_SAYISI attempts. Each mail
// is claimed on its own, right before it is sent, with UPDLOCK + READPAST and a lease, so two server
// processes never send the same mail: the lease only has to outlast one send, never a whole batch.
import { execute, iso, p, query, queryOne, type Db, type Executor } from '../db/sql.ts';
import { renderTestMail } from './mail-templates.ts';

export interface OutgoingMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachments?: ReadonlyArray<{ readonly filename: string; readonly content: Buffer; readonly contentType: string }>;
}

/** Hands one mail to the transport (SMTP in production, a fake in tests); throws when it is refused. */
export type SendMail = (mail: OutgoingMail) => Promise<void>;

/** Minutes to wait after the 1st, 2nd, … failed attempt; 60 after that. */
export const RETRY_MINUTES = [1, 5, 15, 60] as const;
/** Default lease of a claimed mail; see OutboxOptions.leaseMs. */
export const DEFAULT_LEASE_MS = 15 * 60_000;

export const retryDelayMs = (attempt: number): number => (RETRY_MINUTES[attempt - 1] ?? 60) * 60_000;

/**
 * A short, single-line error for son_hata: the transport's code and message, with every secret
 * (the SMTP password and user) blanked, control characters removed and at most 300 characters.
 */
export function cleanError(err: unknown, secrets: readonly (string | null)[] = []): string {
  const e = err as { code?: unknown; responseCode?: unknown; message?: unknown };
  const code = [e?.code, e?.responseCode].filter((x) => typeof x === 'string' || typeof x === 'number').join(' ');
  let text = typeof e?.message === 'string' ? e.message : String(err);
  for (const secret of secrets) if (secret !== null && secret.length >= 3) text = text.split(secret).join('***');
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const out = code === '' ? text : `${code}: ${text}`;
  return (out === '' ? 'Bilinmeyen hata' : out).slice(0, 300);
}

export interface OutboxOptions {
  readonly db: Db;
  readonly send: SendMail;
  /** MAIL_GONDEREN. */
  readonly from: string;
  readonly maxAttempts: number;
  /** The approval document of a form, rendered when the mail is sent; null when the form is gone. */
  readonly attachment: (formId: number) => Promise<Buffer | null>;
  /** Values never written to son_hata (the SMTP password and user). */
  readonly secrets?: readonly (string | null)[];
  readonly now?: () => Date;
  readonly intervalMs?: number;
  /** Most mails sent per run. */
  readonly batch?: number;
  /**
   * How long a claimed mail stays hidden from other processes while it is being sent. Default 15
   * minutes: far longer than the worst single send (SMTP connection 30 s + greeting 30 s + socket
   * 60 s, plus rendering the approval document).
   */
  readonly leaseMs?: number;
  readonly log?: (line: string) => void;
}

export interface Outbox {
  /** Sends the mails due now; returns how many were tried. */
  runOnce(): Promise<number>;
  start(): void;
  /** Stops the timer and waits for a run in progress. */
  stop(): Promise<void>;
}

interface Claimed {
  id: number;
  adres: string;
  konu: string;
  metin: string;
  html: string;
  ek_turu: string | null;
  form_id: number | null;
  deneme: number;
}

export function createOutbox(opts: OutboxOptions): Outbox {
  const now = opts.now ?? (() => new Date());
  const batch = opts.batch ?? 20;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const log = opts.log ?? ((line: string) => console.info(line));
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;
  let stopped = false;

  /** Claims the next due mail for one send: hidden from other processes until the lease ends. */
  async function claimOne(at: Date): Promise<Claimed | null> {
    const rows = await query<Claimed>(
      opts.db,
      `WITH c AS (
         SELECT TOP (1) id, adres, konu, metin, html, ek_turu, form_id, deneme, sonraki_deneme
         FROM dbo.eposta_kutusu WITH (UPDLOCK, READPAST, ROWLOCK)
         WHERE durum = 'bekliyor' AND sonraki_deneme <= @now
         ORDER BY sonraki_deneme, id)
       UPDATE c SET sonraki_deneme = @lease
       OUTPUT inserted.id, inserted.adres, inserted.konu, inserted.metin, inserted.html, inserted.ek_turu, inserted.form_id, inserted.deneme`,
      { now: p.time(at), lease: p.time(new Date(at.getTime() + leaseMs)) },
    );
    return rows[0] ?? null;
  }

  async function deliver(mail: Claimed): Promise<void> {
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    if (mail.ek_turu === 'masraf_pdf' && mail.form_id !== null) {
      const pdf = await opts.attachment(mail.form_id);
      if (pdf !== null) attachments.push({ filename: `masraf-${mail.form_id}.pdf`, content: pdf, contentType: 'application/pdf' });
    }
    await opts.send({ from: opts.from, to: mail.adres, subject: mail.konu, text: mail.metin, html: mail.html, ...(attachments.length > 0 ? { attachments } : {}) });
  }

  async function runOnce(): Promise<number> {
    let tried = 0;
    while (tried < batch && !stopped) {
      const at = now();
      const mail = await claimOne(at);
      if (mail === null) break;
      tried++;
      const attempt = mail.deneme + 1;
      try {
        await deliver(mail);
        await execute(
          opts.db,
          `UPDATE dbo.eposta_kutusu SET durum = 'gonderildi', deneme = @d, gonderim = @at, son_hata = NULL, sonraki_deneme = NULL
           WHERE id = @id AND durum = 'bekliyor'`,
          { id: p.int(mail.id), d: p.int(attempt), at: p.time(now()) },
        );
      } catch (err) {
        const reason = cleanError(err, opts.secrets);
        const failed = attempt >= opts.maxAttempts;
        await execute(
          opts.db,
          `UPDATE dbo.eposta_kutusu SET durum = @durum, deneme = @d, son_hata = @h, sonraki_deneme = @next WHERE id = @id AND durum = 'bekliyor'`,
          {
            id: p.int(mail.id),
            d: p.int(attempt),
            h: p.str(reason, 500),
            durum: p.ascii(failed ? 'hata' : 'bekliyor', 12),
            next: p.time(failed ? null : new Date(at.getTime() + retryDelayMs(attempt))),
          },
        );
        // The address and the reason only; never the body.
        log(`mail gönderilemedi id=${mail.id} deneme=${attempt}/${opts.maxAttempts}${failed ? ' (vazgeçildi)' : ''}: ${reason}`);
      }
    }
    return tried;
  }

  const tick = (): void => {
    if (stopped) return;
    running = runOnce()
      .catch((err: unknown) => {
        log(`giden kutusu çalışamadı: ${cleanError(err, opts.secrets)}`);
        return 0;
      })
      .finally(() => {
        running = null;
        if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 15_000);
      });
  };

  return {
    runOnce,
    start() {
      stopped = false;
      if (timer === null && running === null) timer = setTimeout(tick, 0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (running !== null) await running;
    },
  };
}

export interface EpostaOzet {
  readonly id: number;
  readonly alici: string;
  readonly konu: string;
  readonly durum: 'bekliyor' | 'gonderildi' | 'hata' | 'atlandi';
  readonly deneme: number;
  readonly sonHata: string | null;
  readonly olusturma: string;
  readonly gonderim: string | null;
}

/** Queues the administrators' test mail to `adres`; returns its id. */
export async function enqueueTestMail(ex: Executor, adres: string, appUrl: string | null): Promise<number> {
  const mail = renderTestMail(appUrl);
  const row = await queryOne<{ id: number }>(
    ex,
    `INSERT INTO dbo.eposta_kutusu (alici_id, adres, konu, metin, html, durum, sonraki_deneme)
     OUTPUT inserted.id VALUES (NULL, @a, @k, @t, @h, 'bekliyor', SYSUTCDATETIME())`,
    { a: p.str(adres, 254), k: p.str(mail.konu, 200), t: p.text(mail.metin), h: p.text(mail.html) },
  );
  if (row === null) throw new Error('deneme maili eklenemedi');
  return row.id;
}

export async function listMails(ex: Executor, q: { readonly durum?: EpostaOzet['durum'] | undefined; readonly adet: number }): Promise<EpostaOzet[]> {
  const rows = await query<{ id: number; adres: string; konu: string; durum: EpostaOzet['durum']; deneme: number; son_hata: string | null; olusturma: Date; gonderim: Date | null }>(
    ex,
    `SELECT TOP (@n) id, adres, konu, durum, deneme, son_hata, olusturma, gonderim FROM dbo.eposta_kutusu
     ${q.durum === undefined ? '' : 'WHERE durum = @d'} ORDER BY olusturma DESC, id DESC`,
    { n: p.int(q.adet), d: p.ascii(q.durum ?? null, 12) },
  );
  return rows.map((r) => ({
    id: r.id,
    alici: r.adres,
    konu: r.konu,
    durum: r.durum,
    deneme: r.deneme,
    sonHata: r.son_hata,
    olusturma: iso(r.olusturma) ?? '',
    gonderim: iso(r.gonderim),
  }));
}

/** Puts a failed mail back in the queue with its attempts reset; 'yok' or 'durum' when it cannot. */
export async function retryMail(ex: Executor, id: number): Promise<{ readonly sonuc: 'tamam' | 'yok' | 'durum'; readonly adres?: string }> {
  const row = await queryOne<{ durum: string; adres: string }>(ex, 'SELECT durum, adres FROM dbo.eposta_kutusu WITH (UPDLOCK) WHERE id = @id', { id: p.int(id) });
  if (row === null) return { sonuc: 'yok' };
  const changed = await execute(
    ex,
    `UPDATE dbo.eposta_kutusu SET durum = 'bekliyor', deneme = 0, son_hata = NULL, sonraki_deneme = SYSUTCDATETIME() WHERE id = @id AND durum = 'hata'`,
    { id: p.int(id) },
  );
  return changed === 1 ? { sonuc: 'tamam', adres: row.adres } : { sonuc: 'durum' };
}
