import express, { type Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import type { LoadPayload } from '../integrations/form-data.ts';
import { contentTypeOf, DATE_FORMATS, FORMATS, renderBody, sampleData } from '../integrations/payload.ts';
import type { SecretBox } from '../integrations/secret.ts';
import {
  assertMapping,
  createIntegration,
  deleteIntegration,
  getIntegration,
  getSend,
  listIntegrations,
  listSends,
  loadCatalog,
  queueManual,
  retrySend,
  TRIGGERS,
  updateIntegration,
  type Baslik,
  type EntegrasyonGirdi,
} from '../integrations/store.ts';
import { requireRole, userOf } from './auth.ts';
import { id, parse, routeId, text } from './validation.ts';

export interface IntegrationDeps {
  readonly db: Db;
  /** The values of a form for the preview. */
  readonly load: LoadPayload;
  /** Seals the Basic passwords; null when ENTEGRASYON_ANAHTARI is not set. */
  readonly box: SecretBox | null;
  /** Wakes the send job after a manual send or a retry; absent in tests that run it by hand. */
  readonly kick?: () => void;
}

// Header names a client may not set: the connection's own, and the credentials (Basic is the way).
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'authorization',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'cookie',
]);
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

const HeaderRow = z
  .object({
    ad: z
      .string({ error: 'Başlık adı girilmelidir.' })
      .trim()
      .regex(TOKEN, 'Başlık adı yalnızca harf, rakam ve - gibi işaretler içerebilir (en çok 100 karakter).')
      .refine((n) => !FORBIDDEN_HEADERS.has(n.toLowerCase()), 'Bu başlık kullanılamaz; kimlik bilgisi için Basic kimlik doğrulamasını seçin.'),
    deger: z
      .string({ error: 'Başlık değeri metin olmalıdır.' })
      .max(1000, 'Başlık değeri en fazla 1000 karakter olabilir.')
      .refine((v) => !/[\r\n\u0000]/.test(v), 'Başlık değeri satır sonu içeremez.'),
  })
  .strict();

const HeaderList = z
  .array(HeaderRow, { error: 'Başlıklar bir liste olmalıdır.' })
  .max(20, 'En fazla 20 başlık eklenebilir.')
  .superRefine((rows, ctx) => {
    const names = rows.map((h) => h.ad.toLowerCase());
    const twice = names.findIndex((n, i) => names.indexOf(n) !== i);
    if (twice >= 0) ctx.addIssue({ code: 'custom', message: 'Aynı başlık iki kez eklenmiş.', path: [twice, 'ad'] });
  })
  .default([]);

const MappingRow = z
  .object({
    kaynak: z.string({ error: 'Kaynak alan seçilmelidir.' }).trim().min(1, 'Kaynak alan seçilmelidir.').max(200, 'Bu kaynak alan yok.'),
    alias: z.string({ error: 'Ad girilmelidir.' }).trim().max(200, 'Ad çok uzun.'),
    deger: z
      .string({ error: 'Sabit değer metin olmalıdır.' })
      .max(1000, 'Sabit değer çok uzun.')
      .nullable()
      .optional()
      .transform((v) => (v === null ? undefined : v)),
  })
  .strict();

/** An element or key name: trimmed; the rule itself is checked with the mapping (payload.ts). */
const name = (fallback: string) => z.string({ error: 'Ad metin olmalıdır.' }).trim().max(200, 'Ad çok uzun.').default(fallback);
const optionalName = z
  .string({ error: 'Ad metin olmalıdır.' })
  .trim()
  .max(400, 'En fazla 400 karakter olabilir.')
  .nullable()
  .optional()
  .transform((v) => (v === undefined || v === null || v === '' ? null : v));

// The fields the body depends on; the preview checks only these.
const bodyShape = {
  bicim: z.enum(FORMATS, { error: 'Biçim json ya da xml olmalıdır.' }),
  kok: optionalName,
  xmlAdAlani: optionalName,
  fisListesi: name('FISLER'),
  fisOgesi: name('FIS'),
  tarihBicimi: z.enum(DATE_FORMATS, { error: 'Tarih biçimi YYYY-AA-GG, YYYYAAGG ya da GG.AA.YYYY olmalıdır.' }).default('YYYY-AA-GG'),
  basliklar: HeaderList,
  alanlar: z
    .array(MappingRow, { error: 'Alanlar bir liste olmalıdır.' })
    .min(1, 'En az bir alan seçilmelidir.')
    .max(100, 'En fazla 100 alan eşlenebilir.'),
};

const address = z
  .string({ error: 'Adres girilmelidir.' })
  .trim()
  .min(1, 'Adres girilmelidir.')
  .max(2000, 'Adres en fazla 2000 karakter olabilir.')
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Geçerli bir adres girin (http:// ya da https:// ile).' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'Adres http:// ya da https:// ile başlamalıdır.' });
    else if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'Kullanıcı adını ve şifreyi adrese yazmayın; Basic kimlik doğrulamasını seçin.' });
    } else if (value.includes('#')) ctx.addIssue({ code: 'custom', message: 'Adres # içeremez.' });
  });

// An empty password is taken as "not sent": the stored one stays.
const Credentials = z.discriminatedUnion(
  'tur',
  [
    z
      .object({ tur: z.literal('yok'), kullanici: z.unknown().optional(), sifre: z.unknown().optional() })
      .strict()
      .transform(() => ({ tur: 'yok' as const })),
    z
      .object({
        tur: z.literal('basic'),
        kullanici: text('Kullanıcı adı', 200),
        sifre: z
          .string({ error: 'Şifre metin olmalıdır.' })
          .max(500, 'Şifre en fazla 500 karakter olabilir.')
          .nullable()
          .optional()
          .transform((v) => (v === null || v === undefined || v === '' ? undefined : v)),
      })
      .strict(),
  ],
  { error: 'Kimlik türü yok ya da basic olmalıdır.' },
);

const IntegrationBody = z
  .object({
    ad: text('Ad', 80),
    aktif: z.boolean({ error: 'Aktif true ya da false olmalıdır.' }).default(true),
    adres: address,
    yontem: z.enum(['POST', 'PUT'], { error: 'Yöntem POST ya da PUT olmalıdır.' }).default('POST'),
    tetikleyici: z.enum(TRIGGERS, { error: 'Tetikleyici onaylandi, odendi ya da elle olmalıdır.' }).default('onaylandi'),
    kimlik: Credentials.default({ tur: 'yok' }),
    zamanAsimiSn: z
      .number({ error: 'Zaman aşımı sayı olmalıdır.' })
      .int('Zaman aşımı tam sayı olmalıdır.')
      .min(5, 'Zaman aşımı en az 5 saniye olabilir.')
      .max(120, 'Zaman aşımı en çok 120 saniye olabilir.')
      .default(30),
    ...bodyShape,
  })
  .strict();

// The preview builds the body only: the address, the credentials and the rest of an unsaved editor are not checked.
const PreviewBody = z
  .object({
    entegrasyon: z.looseObject(bodyShape),
    formId: id('Form no').optional(),
  })
  .strict();

const SendBody = z.object({ formId: id('Form no') }).strict();

const SendsQuery = z.object({
  entegrasyonId: id('Entegrasyon').optional(),
  formId: id('Form no').optional(),
  durum: z.enum(['bekliyor', 'gonderildi', 'hata'], { error: 'Durum bekliyor, gonderildi ya da hata olmalıdır.' }).optional(),
  adet: z.coerce.number().int().min(1).max(500).default(50),
});

const contentTypeFor = (bicim: EntegrasyonGirdi['bicim'], headers: readonly Baslik[]): string =>
  headers.find((h) => h.ad.toLowerCase() === 'content-type')?.deger ?? contentTypeOf(bicim);

/** Integrations and their send log (docs/onay-sistemi.md, section 9); administrators only. Mounted after the session check. */
export function integrationRouter(deps: IntegrationDeps): Router {
  const r = express.Router();
  const admin = requireRole('yonetici');
  const kick = deps.kick ?? (() => {});

  r.get('/entegrasyonlar', admin, async (_req, res, next) => {
    try {
      res.json(await listIntegrations(deps.db));
    } catch (err) {
      next(err);
    }
  });

  r.get('/entegrasyonlar/kaynaklar', admin, async (_req, res, next) => {
    try {
      res.json(await loadCatalog(deps.db));
    } catch (err) {
      next(err);
    }
  });

  r.post('/entegrasyonlar/onizle', admin, async (req, res, next) => {
    try {
      const body = parse(PreviewBody, req.body);
      const settings = body.entegrasyon;
      const catalog = await loadCatalog(deps.db);
      assertMapping(settings, catalog, 'entegrasyon.');
      let loaded = null;
      if (body.formId !== undefined) {
        loaded = await deps.load(body.formId);
        if (loaded === null) throw notFound('Masraf formu bulunamadı.');
      }
      res.json({
        govde: renderBody(settings, settings.alanlar, catalog, loaded?.data ?? sampleData(catalog)),
        icerikTuru: contentTypeFor(settings.bicim, settings.basliklar),
        ornek: loaded === null,
        form: loaded?.form ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  r.post('/entegrasyonlar', admin, async (req, res, next) => {
    try {
      res.status(201).json(await createIntegration(deps.db, userOf(res), parse(IntegrationBody, req.body), deps.box));
    } catch (err) {
      next(err);
    }
  });

  r.get('/entegrasyonlar/:id', admin, async (req, res, next) => {
    try {
      res.json(await getIntegration(deps.db, routeId(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  r.put('/entegrasyonlar/:id', admin, async (req, res, next) => {
    try {
      const target = routeId(req.params.id);
      res.json(await updateIntegration(deps.db, userOf(res), target, parse(IntegrationBody, req.body), deps.box));
    } catch (err) {
      next(err);
    }
  });

  r.delete('/entegrasyonlar/:id', admin, async (req, res, next) => {
    try {
      await deleteIntegration(deps.db, userOf(res), routeId(req.params.id));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/entegrasyonlar/:id/gonder', admin, async (req, res, next) => {
    try {
      const target = routeId(req.params.id);
      const body = parse(SendBody, req.body);
      const sendId = await queueManual(deps.db, userOf(res), target, body.formId);
      kick();
      res.status(202).json({ id: sendId });
    } catch (err) {
      next(err);
    }
  });

  r.get('/entegrasyon-gonderimleri', admin, async (req, res, next) => {
    try {
      res.json(await listSends(deps.db, parse(SendsQuery, req.query)));
    } catch (err) {
      next(err);
    }
  });

  r.get('/entegrasyon-gonderimleri/:id', admin, async (req, res, next) => {
    try {
      res.json(await getSend(deps.db, routeId(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/entegrasyon-gonderimleri/:id/yeniden', admin, async (req, res, next) => {
    try {
      await retrySend(deps.db, userOf(res), routeId(req.params.id));
      kick();
      res.status(202).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}
