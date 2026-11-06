import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import { createLoginLimiter, type LoginLimiter } from '../auth/login-limiter.ts';
import { findSession } from '../auth/sessions.ts';
import { ExtractionError, type ExtractInvoice } from '../claude/extractor.ts';
import type { ClaudeOlcum, YanitOlcum } from '../claude/olcum.ts';
import { ROOT_DIR, type AuthSettings } from '../config.ts';
import type { Db } from '../db/sql.ts';
import { createExpenseService } from '../expenses/forms.ts';
import { isPrivileged } from '../expenses/rules.ts';
import { detectFileType } from '../invoice/file-type.ts';
import { createInvoiceStorage, type InvoiceStorage, type StoredRecord } from '../invoice/storage.ts';
import { createActivityLog, type TrackMeta } from '../reading/activity.ts';
import { createBatchQueue, type BatchInput, type BatchPlace, type ItemError } from '../reading/batch-queue.ts';
import { createInvoiceReader, type ReadHooks, type ReadInput, type ReadInvoice, type ReadResult } from '../reading/reader.ts';
import { accountRouter, loginHandler } from './account-routes.ts';
import { adminRouter } from './admin-routes.ts';
import { requireSession, tokenOf, userOf } from './auth.ts';
import { expenseRouter } from './expense-routes.ts';
import { liveStream, type Visibility } from './live.ts';
import { isLocalNetworkAddress } from './network.ts';
import { HttpError, readBatchUpload, readUpload, senderOf, wantsRefresh } from './uploads.ts';

export const DEFAULT_AUTH: AuthSettings = {
  sessionTtlMs: 168 * 3_600_000,
  loginMaxAttempts: 10,
  loginLockMs: 15 * 60_000,
  passwordMinLength: 8,
};

export interface AppDeps {
  readonly extract: ExtractInvoice;
  readonly db: Db;
  /** Defaults to the SQL storage on `db`. */
  readonly storage?: InvoiceStorage;
  readonly maxFileBytes: number;
  /** Port the server listens on; used for the Host/Origin checks. */
  readonly port: number;
  /**
   * Set when the service is open to the local network (AG_ERISIMI=yerel): the extra host names it
   * answers to, read on each request so a changed Wi-Fi address keeps working.
   */
  readonly lanHosts?: () => readonly string[];
  readonly auth?: AuthSettings;
  /** Currency of the approval ranges. Default TRY. */
  readonly baseCurrency?: string;
  readonly loginLimiter?: LoginLimiter;
  /** Files Claude reads at the same time, single and multi-file uploads together. Default 2. */
  readonly maxConcurrent?: number;
  /** Most files in one multi-file upload. Default 50. */
  readonly maxBatchFiles?: number;
  /** Largest multi-file request body. Default 200 MB. */
  readonly maxBatchBytes?: number;
  /** Idle keep-alive interval of the live stream. Default 20 s. */
  readonly liveHeartbeatMs?: number;
  readonly log?: (line: string) => void;
}

const EXTRACTION_STATUS: Record<ExtractionError['code'], number> = {
  claude_auth: 503,
  claude_limit: 429,
  claude_failed: 502,
  claude_timeout: 504,
  invalid_output: 422,
};

const ID_REGEX = /^\d{8}-\d{6}-[a-f0-9]{8}$/;
const UNSUPPORTED: ItemError = { kod: 'desteklenmeyen_dosya', mesaj: 'Yalnızca PDF, PNG, JPEG, WEBP veya GIF fatura dosyası kabul edilir.' };
const MB = 1024 * 1024;

/** Response body: the invoice plus an `olcum` field with the measurements. */
function responseBody(record: StoredRecord, kaynak: YanitOlcum['kaynak'], started: number): object {
  const olcum: YanitOlcum = { kaynak, istekSuresiMs: Date.now() - started, okuma: record.olcum ?? null };
  return { ...record.sonuc, olcum };
}

function describeRun(o: ClaudeOlcum | undefined): string {
  if (o === undefined) return '';
  const n = (v: number | null): string => (v === null ? '?' : String(v));
  const steps = o.adimlar ?? [];
  // With a cascade: which models read the file, and why the reads that were not used were dropped.
  const dropped = steps.filter((a) => !a.kullanildi).flatMap((a) => (a.hata !== null ? [a.hata] : a.sorunlar));
  const cascade = steps.length > 1 ? ` kademe=${steps.map((a) => a.model).join('>')} neden="${dropped.join(' ')}"` : '';
  return (
    ` model=${o.model} effort=${o.effort ?? 'varsayılan'} tur=${n(o.tur)} sure=${o.sureMs}ms api=${n(o.apiSureMs)}ms` +
    ` girdi=${n(o.girdiToken)} onbellekten=${n(o.onbellektenToken)} onbellege=${n(o.onbellegeToken)} cikti=${n(o.ciktiToken)}${cascade}`
  );
}

function describeResult({ record, reused }: ReadResult): string {
  return reused
    ? `fatura kayıttan döndü id=${record.id} (aynı dosya daha önce okunmuş)`
    : `fatura okundu id=${record.id} kalem=${record.sonuc.kalemler.length}${describeRun(record.olcum)}`;
}

/** Content-Disposition with the original file name, safe for any characters. */
function inlineDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const log = deps.log ?? ((line: string) => console.info(line));
  const localHosts = ['127.0.0.1', 'localhost'];
  const hostNames = (): readonly string[] => (deps.lanHosts === undefined ? localHosts : [...localHosts, ...deps.lanHosts()]);
  const hostAllowed = (host: string): boolean => hostNames().some((h) => host === `${h}:${deps.port}`);
  const originAllowed = (origin: string): boolean => hostNames().some((h) => origin === `http://${h}:${deps.port}`);
  const maxConcurrent = deps.maxConcurrent ?? 2;
  const maxBatchFiles = deps.maxBatchFiles ?? 50;
  const maxBatchBytes = deps.maxBatchBytes ?? 200 * MB;
  const auth = deps.auth ?? DEFAULT_AUTH;
  const baseCurrency = deps.baseCurrency ?? 'TRY';
  const storage = deps.storage ?? createInvoiceStorage(deps.db);
  const expenses = createExpenseService(deps.db, { baseCurrency });
  const limiter = deps.loginLimiter ?? createLoginLimiter(auth.loginMaxAttempts, auth.loginLockMs);

  // Every upload is noted for its sender; that is what lets them open the invoice and attach it to a form.
  const reader = createInvoiceReader(deps.extract, storage, maxConcurrent);
  const readAndNote: ReadInvoice = async (input, hooks) => {
    const result = await reader(input, hooks);
    if (input.kullaniciId !== undefined && input.kullaniciId !== null) {
      await storage.addUpload({
        kayitId: result.record.id,
        kullaniciId: input.kullaniciId,
        dosyaAdi: input.name,
        // A fresh read already stored the file; an answer from an older record may still lack it.
        ...(result.reused ? { dosya: { icerik: input.buffer, mime: input.type.mime } } : {}),
      });
    }
    return result;
  };

  // Every read goes through the activity log, so the panel's live monitor sees API uploads too.
  const activity = createActivityLog({ esZamanli: maxConcurrent });
  const read = activity.track(readAndNote);
  const batchRead = (input: ReadInput, hooks: ReadHooks, place: BatchPlace<TrackMeta>): Promise<ReadResult> =>
    read(
      { ...input, kullaniciId: place.context?.kullanici?.id ?? null },
      { ...(place.context ?? { kaynak: 'api' }), kuyrukId: place.kuyrukId, sira: place.sira },
      hooks,
    );
  const queue = createBatchQueue<TrackMeta>(batchRead, {
    esZamanli: maxConcurrent,
    onResult: (result) => log(describeResult(result)),
    onError: (err) => {
      if (!(err instanceof ExtractionError)) log(`hata sunucu_hatasi: ${err instanceof Error ? err.message : String(err)}`);
    },
    onRejected: (file, place) =>
      activity.rejected(
        { ...(place.context ?? { kaynak: 'api' }), dosyaAdi: file.name, boyut: file.size, kuyrukId: place.kuyrukId, sira: place.sira },
        file.hata,
      ),
  });
  const tooLarge = (): HttpError =>
    new HttpError(413, 'dosya_cok_buyuk', `Dosya en fazla ${Math.floor(deps.maxFileBytes / MB)} MB olabilir.`);

  /** The sender as the live monitor shows it. */
  const senderMeta = (req: Request, res: Response): TrackMeta => {
    const user = userOf(res);
    return { ...senderOf(req), kullanici: { id: user.id, adSoyad: user.adSoyad } };
  };
  /** Employees see only their own reads in the monitor; accounting and administrators see all. */
  const visibleTo = (res: Response): Visibility | undefined => {
    const user = userOf(res);
    return isPrivileged(user) ? undefined : (a) => a.kullanici?.id === user.id;
  };

  app.disable('x-powered-by');

  // Local service: only this machine or, when opened, the local network; reject other hosts (DNS
  // rebinding) and cross-site browser requests.
  app.use((req, _res, next) => {
    if (!isLocalNetworkAddress(req.socket.remoteAddress)) {
      next(new HttpError(403, 'izinsiz_ag', 'Bu servise yalnızca bu bilgisayardan ya da yerel ağdan ulaşılabilir.'));
      return;
    }
    const host = req.headers.host;
    if (host === undefined || !hostAllowed(host.toLowerCase())) {
      const where = deps.lanHosts === undefined ? '127.0.0.1 veya localhost' : 'bu bilgisayarın yerel ağ adresi, 127.0.0.1 veya localhost';
      next(new HttpError(403, 'izinsiz_host', `Bu servis yalnızca ${where} üzerinden kullanılabilir.`));
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin.toLowerCase())) {
      next(new HttpError(403, 'izinsiz_kaynak', 'Başka bir siteden gelen istekler kabul edilmez.'));
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ durum: 'ok' });
  });

  const json = express.json({ limit: '256kb' });
  const accountDeps = { db: deps.db, auth, limiter, expenses };

  // Signing in is the only open API call; everything after this line needs a session.
  app.post('/api/oturum', json, loginHandler(accountDeps));
  app.use('/api', requireSession(deps.db, auth.sessionTtlMs));

  app.post('/api/invoices', express.raw({ type: () => true, limit: deps.maxFileBytes + MB }), async (req, res, next) => {
    try {
      const sender = senderMeta(req, res);
      const upload = await readUpload(req);
      // Refused files still show up in the live monitor, with the reason.
      const refuse = (err: HttpError): never => {
        activity.rejected({ ...sender, dosyaAdi: upload.name, boyut: upload.buffer.length }, { kod: err.code, mesaj: err.message });
        throw err;
      };
      if (upload.buffer.length > deps.maxFileBytes) return refuse(tooLarge());
      const type = detectFileType(upload.buffer);
      if (type === null) return refuse(new HttpError(415, UNSUPPORTED.kod, UNSUPPORTED.mesaj));
      const started = Date.now();
      const result = await read(
        { buffer: upload.buffer, type, name: upload.name, force: wantsRefresh(req), kullaniciId: userOf(res).id },
        sender,
      );
      const { record, reused } = result;
      log(describeResult(result));
      res.location(`/api/invoices/${record.id}`).setHeader('X-Fatura-Id', record.id);
      if (reused) res.setHeader('X-Fatura-Onbellek', '1');
      // 201: a new record was created; 200: the stored result of an identical file was returned.
      res.status(reused ? 200 : 201).json(responseBody(record, reused ? 'kayit' : 'claude', started));
    } catch (err) {
      next(err);
    }
  });

  // Multi-file upload: answers once each file is known to be done or waiting for Claude.
  app.post('/api/invoices/toplu', express.raw({ type: () => true, limit: maxBatchBytes + MB }), async (req, res, next) => {
    try {
      const files = await readBatchUpload(req);
      if (files.length === 0) throw new HttpError(400, 'dosya_yok', 'Formda dosya bulunamadı.');
      if (files.length > maxBatchFiles) {
        throw new HttpError(400, 'cok_fazla_dosya', `Bir seferde en fazla ${maxBatchFiles} dosya gönderilebilir.`);
      }
      // A wrong or oversized file fails on its own; the rest of the batch is still read.
      const inputs = files.map((f): BatchInput => {
        const size = f.buffer.length;
        if (size > deps.maxFileBytes) return { name: f.name, size, hata: { kod: tooLarge().code, mesaj: tooLarge().message } };
        const type = detectFileType(f.buffer);
        if (type === null) return { name: f.name, size, hata: UNSUPPORTED };
        return { name: f.name, buffer: f.buffer, type };
      });
      const batch = await queue.add(inputs, wantsRefresh(req), senderMeta(req, res));
      const stored = batch.dosyalar.filter((d) => d.onbellek).length;
      log(`kuyruğa alındı id=${batch.id} dosya=${batch.sayac.toplam} kayittan=${stored} hata=${batch.sayac.hata}`);
      // 200: every file is already answered (read before or refused); 202: some still wait for Claude.
      res.status(batch.bitti ? 200 : 202).location(`/api/invoices/toplu/${batch.id}`).json(batch);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/invoices/toplu/:id', (req, res, next) => {
    const user = userOf(res);
    const batch = ID_REGEX.test(req.params.id) ? queue.get(req.params.id) : null;
    const owner = batch === null ? undefined : queue.contextOf(req.params.id)?.kullanici?.id;
    if (batch === null || (owner !== user.id && !isPrivileged(user))) {
      next(new HttpError(404, 'bulunamadi', 'Kuyruk bulunamadı. Sunucu yeniden başladıysa kuyruk silinmiştir; okunan faturalar kayıtlarda durur.'));
      return;
    }
    res.json(batch);
  });

  // Live monitor: a snapshot, and a Server-Sent Events stream of every change.
  app.get('/api/izleme', (_req, res) => {
    res.json(activity.snapshot(visibleTo(res)));
  });
  app.get(
    '/api/izleme/akis',
    liveStream(activity, {
      heartbeatMs: deps.liveHeartbeatMs,
      visibleTo,
      // Does not extend the session: an open monitor tab alone must not keep a session alive forever.
      stillAllowed: async (req) => {
        const token = tokenOf(req);
        return token !== null && (await findSession(deps.db, token, auth.sessionTtlMs, { touch: false })) !== null;
      },
    }),
  );

  app.get('/api/invoices', async (_req, res, next) => {
    try {
      const user = userOf(res);
      res.json(await storage.list(isPrivileged(user) ? {} : { kullaniciId: user.id }));
    } catch (err) {
      next(err);
    }
  });

  const readable = async (id: string, res: Response): Promise<void> => {
    if (!(await storage.canRead(id, userOf(res)))) throw new HttpError(404, 'bulunamadi', 'Kayıt bulunamadı.');
  };

  app.get('/api/invoices/:id', async (req, res, next) => {
    try {
      const started = Date.now();
      await readable(req.params.id, res);
      const record = await storage.get(req.params.id);
      if (record === null) throw new HttpError(404, 'bulunamadi', 'Kayıt bulunamadı.');
      res.setHeader('X-Fatura-Id', record.id).json(responseBody(record, 'kayit', started));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/invoices/:id/dosya', async (req, res, next) => {
    try {
      await readable(req.params.id, res);
      const [file, record] = await Promise.all([storage.getFile(req.params.id), storage.get(req.params.id)]);
      if (file === null) throw new HttpError(404, 'dosya_yok', 'Bu faturanın orijinal dosyası saklanmamış.');
      res
        .status(200)
        .set({
          'Content-Type': file.mime,
          'Content-Length': String(file.icerik.length),
          'Content-Disposition': inlineDisposition(record?.dosyaAdi ?? 'fatura'),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=3600',
        })
        .end(file.icerik);
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', json, accountRouter(accountDeps), adminRouter({ db: deps.db, baseCurrency, passwordMinLength: auth.passwordMinLength }), expenseRouter(expenses));

  app.use(express.static(join(ROOT_DIR, 'public'), { index: 'index.html' }));

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'bulunamadi', 'Kaynak bulunamadı.'));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let code = 'sunucu_hatasi';
    let message = 'Beklenmeyen bir hata oluştu.';
    let details: HttpError['details'];
    const type = (err as { type?: string } | null)?.type;
    if (err instanceof HttpError) {
      ({ status, code, message, details } = err);
    } else if (err instanceof ExtractionError) {
      status = EXTRACTION_STATUS[err.code];
      code = err.code;
      message = err.message;
    } else if (type === 'entity.too.large') {
      status = 413;
      if (req.path === '/api/invoices/toplu') {
        code = 'istek_cok_buyuk';
        message = `Çoklu yüklemede dosyaların toplamı en fazla ${Math.floor(maxBatchBytes / MB)} MB olabilir. Dosyaları birkaç parçada gönderin.`;
      } else if (req.path.startsWith('/api/invoices')) {
        ({ code, message } = tooLarge());
      } else {
        code = 'istek_cok_buyuk';
        message = 'İstek gövdesi çok büyük.';
      }
    } else if (type === 'entity.parse.failed') {
      status = 400;
      code = 'gecersiz_json';
      message = 'İstek gövdesi geçerli bir JSON değil.';
    }
    if (status >= 500) {
      // The console is local, so it may name the cause; the response never does.
      const known = err instanceof HttpError || err instanceof ExtractionError;
      log(`hata ${code}: ${message}${known ? '' : ` (${err instanceof Error ? err.message : String(err)})`}`);
    }
    res.status(status).json({ hata: { kod: code, mesaj: message, ...details } });
  });

  return app;
}
