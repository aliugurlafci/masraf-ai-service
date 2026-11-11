// The integration send job (docs/onay-sistemi.md, section 9, "Gönderim zamanı ve kuyruk"): sends the
// queued forms to their integration's address, retries what may work later at growing intervals and
// keeps the body and the start of the reply. Each send is claimed on its own with UPDLOCK + READPAST
// and a lease, as the mail outbox does, so two server processes never send the same form twice.
import { execute, p, query, type Db } from '../db/sql.ts';
import { cleanError, retryDelayMs } from '../notifications/outbox.ts';
import type { LoadPayload } from './form-data.ts';
import { contentTypeOf, mappingProblems, renderBody } from './payload.ts';
import type { SecretBox } from './secret.ts';
import { loadCatalog, loadForSend, type IntegrationForSend } from './store.ts';

/** Characters of the reply kept for the administrator. */
export const REPLY_CHARS = 2000;
/** Bytes of the reply read at most; the rest is dropped unread. */
const REPLY_BYTES = 16 * 1024;
/** Default lease: longer than the longest send (120 s timeout) plus building the body. */
export const DEFAULT_LEASE_MS = 10 * 60_000;

export interface SenderOptions {
  readonly db: Db;
  readonly load: LoadPayload;
  /** Opens stored passwords; null when ENTEGRASYON_ANAHTARI is not set. */
  readonly box: SecretBox | null;
  readonly maxAttempts: number;
  /** The HTTP client; the global fetch by default. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  /** Most sends tried per run. */
  readonly batch?: number;
  readonly leaseMs?: number;
  readonly log?: (line: string) => void;
}

export interface IntegrationSender {
  /** Sends what is due now; returns how many were tried. */
  runOnce(): Promise<number>;
  start(): void;
  /** Runs now (a manual send or a retry was queued) instead of waiting for the timer. */
  kick(): void;
  /** Stops the timer and waits for a run in progress. */
  stop(): Promise<void>;
}

interface Claimed {
  id: number;
  entegrasyon_id: number;
  form_id: number;
  deneme: number;
}

/** What one attempt ended with. `retry` false: trying again later cannot help. */
interface Outcome {
  readonly ok: boolean;
  readonly retry: boolean;
  readonly http: number | null;
  readonly error: string | null;
  readonly body: string | null;
  readonly contentType: string | null;
  readonly reply: string | null;
}

const fatal = (error: string): Outcome => ({ ok: false, retry: false, http: null, error, body: null, contentType: null, reply: null });

/** Reads at most REPLY_BYTES of the reply as text, without control characters other than line breaks and tabs. */
async function replyText(res: Response): Promise<string | null> {
  if (res.body === null) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < REPLY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(Buffer.concat(chunks).subarray(0, REPLY_BYTES))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return text === '' ? null : text.slice(0, REPLY_CHARS);
}

/** Network failures in Turkish; fetch hides the cause (ECONNREFUSED, ENOTFOUND, …) one level down. */
function networkError(err: unknown, timeoutSec: number, secrets: readonly (string | null)[]): string {
  const e = err as { name?: unknown; cause?: { code?: unknown; name?: unknown; message?: unknown } };
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return `Zaman aşımı (${timeoutSec} sn).`;
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : null;
  if (code !== null) return `Bağlantı kurulamadı: ${code}`;
  return `Bağlantı kurulamadı: ${cleanError(e?.cause ?? err, secrets)}`;
}

export function createIntegrationSender(opts: SenderOptions): IntegrationSender {
  const now = opts.now ?? (() => new Date());
  const batch = opts.batch ?? 20;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((line: string) => console.info(line));
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;
  let again = false;
  let started = false;
  let stopped = false;

  /** The next due send, hidden from other processes until the lease ends. Sends of an inactive integration wait, manual ones excepted. */
  async function claimOne(at: Date): Promise<Claimed | null> {
    const rows = await query<Claimed>(
      opts.db,
      `WITH c AS (
         SELECT TOP (1) g.id, g.entegrasyon_id, g.form_id, g.deneme, g.sonraki_deneme
         FROM dbo.entegrasyon_gonderimleri g WITH (UPDLOCK, READPAST, ROWLOCK)
         WHERE g.durum = 'bekliyor' AND g.sonraki_deneme <= @now
           AND (g.tetikleyen = 'elle' OR EXISTS (SELECT 1 FROM dbo.entegrasyonlar e WHERE e.id = g.entegrasyon_id AND e.aktif = 1))
         ORDER BY g.sonraki_deneme, g.id)
       UPDATE c SET sonraki_deneme = @lease
       OUTPUT inserted.id, inserted.entegrasyon_id, inserted.form_id, inserted.deneme`,
      { now: p.time(at), lease: p.time(new Date(at.getTime() + leaseMs)) },
    );
    return rows[0] ?? null;
  }

  function headersFor(integration: IntegrationForSend, password: string | null): Headers {
    const headers = new Headers({ 'Content-Type': contentTypeOf(integration.bicim), Accept: '*/*' });
    for (const h of integration.basliklar) headers.set(h.ad, h.deger);
    if (integration.kimlik.tur === 'basic' && password !== null) {
      headers.set('Authorization', `Basic ${Buffer.from(`${integration.kimlik.kullanici ?? ''}:${password}`, 'utf8').toString('base64')}`);
    }
    return headers;
  }

  async function attempt(send: Claimed, integration: IntegrationForSend): Promise<Outcome> {
    const catalog = await loadCatalog(opts.db);
    const problems = mappingProblems(integration.alanlar, catalog);
    if (problems.length > 0) return fatal(`Alan eşlemesi düzeltilmeli: ${problems.join(' ')}`);
    let password: string | null = null;
    if (integration.kimlik.tur === 'basic') {
      password = integration.kimlik.sifre === null || opts.box === null ? null : opts.box.open(integration.kimlik.sifre);
      if (password === null) {
        return fatal(
          opts.box === null
            ? 'Şifre çözülemedi: .env dosyasında ENTEGRASYON_ANAHTARI tanımlı değil.'
            : 'Şifre çözülemedi (ENTEGRASYON_ANAHTARI değişmiş olabilir); entegrasyonun şifresini yeniden girin.',
        );
      }
    }
    const loaded = await opts.load(send.form_id);
    if (loaded === null) return fatal('Masraf formu bulunamadı.');
    const body = renderBody(integration, integration.alanlar, catalog, loaded.data);
    const headers = headersFor(integration, password);
    const contentType = headers.get('Content-Type');
    const secrets = [password, headers.get('Authorization'), password === null ? null : Buffer.from(`${integration.kimlik.kullanici ?? ''}:${password}`).toString('base64')];
    let res: Response;
    try {
      res = await doFetch(integration.adres, {
        method: integration.yontem,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(integration.zamanAsimiSn * 1000),
      });
    } catch (err) {
      return { ok: false, retry: true, http: null, error: networkError(err, integration.zamanAsimiSn, secrets), body, contentType, reply: null };
    }
    let reply: string | null = null;
    try {
      reply = await replyText(res);
    } catch {
      // A reply cut short still has its status.
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, retry: false, http: res.status, error: null, body, contentType, reply };
    const retry = res.status === 408 || res.status === 429 || res.status >= 500;
    const detail = reply === null ? '' : `: ${cleanError(new Error(reply), secrets).slice(0, 200)}`;
    const redirect = res.status >= 300 && res.status < 400 ? ` (yönlendirme izlenmez${res.headers.get('location') ? `: ${res.headers.get('location')}` : ''})` : '';
    return { ok: false, retry, http: res.status, error: `HTTP ${res.status}${redirect}${detail}`.slice(0, 500), body, contentType, reply };
  }

  async function runOnce(): Promise<number> {
    let tried = 0;
    while (tried < batch && !stopped) {
      const at = now();
      const send = await claimOne(at);
      if (send === null) break;
      tried++;
      const tryNo = send.deneme + 1;
      const integration = await loadForSend(opts.db, send.entegrasyon_id);
      // Deleted meanwhile: the send went with it.
      if (integration === null) continue;
      let outcome: Outcome;
      try {
        outcome = await attempt(send, integration);
      } catch (err) {
        // Building the body failed on a database error; it may work next time.
        outcome = { ok: false, retry: true, http: null, error: `Gövde hazırlanamadı: ${cleanError(err)}`, body: null, contentType: null, reply: null };
      }
      const failed = !outcome.ok && (!outcome.retry || tryNo >= opts.maxAttempts);
      const durum = outcome.ok ? 'gonderildi' : failed ? 'hata' : 'bekliyor';
      await execute(
        opts.db,
        `UPDATE dbo.entegrasyon_gonderimleri
         SET durum = @durum, deneme = @d, http_durum = @http, son_hata = @h, govde = COALESCE(@govde, govde), icerik_turu = COALESCE(@tur, icerik_turu),
             yanit = @yanit, sonraki_deneme = @next, gonderim = CASE WHEN @durum = 'gonderildi' THEN @at ELSE gonderim END
         WHERE id = @id AND durum = 'bekliyor'`,
        {
          id: p.int(send.id),
          durum: p.ascii(durum, 12),
          d: p.int(tryNo),
          http: p.int(outcome.http),
          h: p.str(outcome.error, 500),
          govde: p.text(outcome.body),
          tur: p.ascii(outcome.contentType === null ? null : outcome.contentType.slice(0, 200), 200),
          yanit: p.str(outcome.reply, REPLY_CHARS),
          next: p.time(durum === 'bekliyor' ? new Date(at.getTime() + retryDelayMs(tryNo)) : null),
          at: p.time(now()),
        },
      );
      if (!outcome.ok) {
        // The integration, the form and the reason only; never the body or a password.
        log(`entegrasyon gönderilemedi #${send.id} (${integration.ad}, form #${send.form_id}) deneme=${tryNo}/${opts.maxAttempts}${failed ? ' (vazgeçildi)' : ''}: ${outcome.error ?? ''}`);
      }
    }
    return tried;
  }

  const tick = (): void => {
    if (stopped) return;
    timer = null;
    running = runOnce()
      .catch((err: unknown) => {
        log(`entegrasyon gönderim işi çalışamadı: ${cleanError(err)}`);
        return 0;
      })
      .finally(() => {
        running = null;
        if (stopped) return;
        timer = setTimeout(tick, again ? 0 : (opts.intervalMs ?? 15_000));
        again = false;
      });
  };

  return {
    runOnce,
    start() {
      started = true;
      stopped = false;
      if (timer === null && running === null) timer = setTimeout(tick, 0);
    },
    kick() {
      if (!started || stopped) return;
      if (running !== null) {
        again = true;
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(tick, 0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (running !== null) await running;
    },
  };
}
