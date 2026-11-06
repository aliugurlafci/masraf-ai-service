import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import { ExtractionError, type ExtractInvoice } from './claude-extractor.ts';
import { ROOT_DIR } from './config.ts';
import { detectFileType } from './file-type.ts';
import { createInvoiceReader } from './invoice-reader.ts';
import type { ClaudeOlcum, YanitOlcum } from './olcum.ts';
import type { InvoiceStorage, StoredRecord } from './storage.ts';

export interface AppDeps {
  readonly extract: ExtractInvoice;
  readonly storage: InvoiceStorage;
  readonly maxFileBytes: number;
  /** Port the server listens on; used for the Host/Origin checks. */
  readonly port: number;
  readonly log?: (line: string) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EXTRACTION_STATUS: Record<ExtractionError['code'], number> = {
  claude_auth: 503,
  claude_limit: 429,
  claude_failed: 502,
  claude_timeout: 504,
  invalid_output: 422,
};

interface UploadedFile {
  readonly buffer: Buffer;
  readonly name: string;
}

/** Accepts `multipart/form-data` (field "file") or the raw file as the request body. */
async function readUpload(req: Request): Promise<UploadedFile> {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new HttpError(400, 'dosya_yok', 'Fatura dosyası gönderilmedi.');
  }
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await new globalThis.Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(body),
      }).formData();
    } catch {
      throw new HttpError(400, 'gecersiz_form', 'multipart/form-data gövdesi çözümlenemedi.');
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new HttpError(400, 'dosya_yok', 'Formda "file" alanında bir dosya bulunamadı.');
    }
    return { buffer: Buffer.from(await file.arrayBuffer()), name: file.name };
  }
  const headerName = req.headers['x-file-name'];
  let name = 'fatura';
  if (typeof headerName === 'string' && headerName !== '') {
    try {
      name = decodeURIComponent(headerName);
    } catch {
      name = headerName;
    }
  }
  return { buffer: body, name };
}

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

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const log = deps.log ?? ((line: string) => console.info(line));
  const allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${deps.port}`, `http://localhost:${deps.port}`]);
  const read = createInvoiceReader(deps.extract, deps.storage);

  app.disable('x-powered-by');

  // Local-only service: reject other hosts (DNS rebinding) and cross-site browser requests.
  app.use((req, _res, next) => {
    const host = req.headers.host;
    if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
      next(new HttpError(403, 'izinsiz_host', 'Bu servis yalnızca 127.0.0.1 veya localhost üzerinden kullanılabilir.'));
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
      next(new HttpError(403, 'izinsiz_kaynak', 'Başka bir siteden gelen istekler kabul edilmez.'));
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ durum: 'ok' });
  });

  app.post(
    '/api/invoices',
    express.raw({ type: () => true, limit: deps.maxFileBytes + 1024 * 1024 }),
    async (req, res, next) => {
      try {
        const upload = await readUpload(req);
        if (upload.buffer.length > deps.maxFileBytes) {
          throw new HttpError(413, 'dosya_cok_buyuk', `Dosya en fazla ${Math.floor(deps.maxFileBytes / 1024 / 1024)} MB olabilir.`);
        }
        const type = detectFileType(upload.buffer);
        if (type === null) {
          throw new HttpError(415, 'desteklenmeyen_dosya', 'Yalnızca PDF, PNG, JPEG, WEBP veya GIF fatura dosyası kabul edilir.');
        }
        const started = Date.now();
        const force = ['1', 'true', 'evet'].includes(String(req.query.yenile ?? '').toLowerCase());
        const { record, reused } = await read({ buffer: upload.buffer, type, name: upload.name, force });
        log(
          reused
            ? `fatura kayıttan döndü id=${record.id} (aynı dosya daha önce okunmuş)`
            : `fatura okundu id=${record.id} kalem=${record.sonuc.kalemler.length}${describeRun(record.olcum)}`,
        );
        res.location(`/api/invoices/${record.id}`).setHeader('X-Fatura-Id', record.id);
        if (reused) res.setHeader('X-Fatura-Onbellek', '1');
        // 201: a new record was created; 200: the stored result of an identical file was returned.
        res.status(reused ? 200 : 201).json(responseBody(record, reused ? 'kayit' : 'claude', started));
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/api/invoices', async (_req, res, next) => {
    try {
      res.json(await deps.storage.list());
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/invoices/:id', async (req, res, next) => {
    try {
      const started = Date.now();
      const record = await deps.storage.get(req.params.id);
      if (record === null) throw new HttpError(404, 'bulunamadi', 'Kayıt bulunamadı.');
      res.setHeader('X-Fatura-Id', record.id).json(responseBody(record, 'kayit', started));
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static(join(ROOT_DIR, 'public'), { index: 'index.html' }));

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'bulunamadi', 'Kaynak bulunamadı.'));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let code = 'sunucu_hatasi';
    let message = 'Beklenmeyen bir hata oluştu.';
    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err instanceof ExtractionError) {
      status = EXTRACTION_STATUS[err.code];
      code = err.code;
      message = err.message;
    } else if ((err as { type?: string }).type === 'entity.too.large') {
      status = 413;
      code = 'dosya_cok_buyuk';
      message = `Dosya en fazla ${Math.floor(deps.maxFileBytes / 1024 / 1024)} MB olabilir.`;
    }
    if (status >= 500) log(`hata ${code}: ${message}`);
    res.status(status).json({ hata: { kod: code, mesaj: message } });
  });

  return app;
}
