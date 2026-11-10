// Definition lists over HTTP (docs/onay-sistemi.md, section 6, "Tanım listeleri"): organisations, cost
// centres, the options of 'liste' fields and the categories' delete, Excel export and import. The other
// category routes are in admin-routes.ts. Mounted after the session check.
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/sql.ts';
import {
  CATEGORIES,
  COST_CENTERS,
  createRecord,
  deleteRecord,
  exportList,
  findListField,
  importList,
  listRecords,
  optionsOf,
  ORGANIZATIONS,
  updateRecord,
  type CrudDef,
  type ListDef,
} from '../definitions/lists.ts';
import { HttpError } from '../errors.ts';
import { XLSX_MIME } from '../excel/xlsx.ts';
import { deleteCategory } from '../expenses/categories.ts';
import { requireRole, userOf } from './auth.ts';
import { bool, optionalText, parse, routeId, text } from './validation.ts';

export interface DefinitionDeps {
  readonly db: Db;
}

const MB = 1024 * 1024;
/** Largest Excel file an import takes. */
export const MAX_IMPORT_BYTES = 5 * MB;

const kod = text('Kod', 50);
const aktif = z.boolean({ error: 'Aktif alanı true ya da false olmalıdır.' });
const sira = z
  .number({ error: 'Sıra tam sayı olmalıdır.' })
  .int('Sıra tam sayı olmalıdır.')
  .min(0, 'Sıra sıfırdan küçük olamaz.')
  .max(1_000_000, 'Sıra çok büyük.');
/** ISO 4217, upper-cased; empty text or null clears it. */
const paraBirimi = z
  .string({ error: 'Para birimi metin olmalıdır.' })
  .trim()
  .toUpperCase()
  .refine((v) => v === '' || /^[A-Z]{3}$/.test(v), 'Para birimi üç harfli ISO kodu olmalıdır (TRY, USD, EUR).')
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

const NewOrganization = z.object({ kod, ad: text('Organizasyon adı', 200), paraBirimi });
const OrganizationPatch = z.object({ kod: kod.optional(), ad: text('Organizasyon adı', 200).optional(), paraBirimi, aktif: aktif.optional() }).strict();
const NewCostCenter = z.object({ kod, aciklama: optionalText('Açıklama', 200) });
const CostCenterPatch = z.object({ kod: kod.optional(), aciklama: optionalText('Açıklama', 200), aktif: aktif.optional() }).strict();
const NewOption = z.object({ kod, ad: optionalText('Açıklama', 200) });
const OptionPatch = z.object({ kod: kod.optional(), ad: optionalText('Açıklama', 200), aktif: aktif.optional(), sira: sira.optional() }).strict();

const PageQuery = z.object({
  q: z.string({ error: 'Arama metni geçersiz.' }).max(100, 'Arama metni en fazla 100 karakter olabilir.').optional(),
  aktif: bool,
  sayfa: z.coerce.number({ error: 'Sayfa sayı olmalıdır.' }).int('Sayfa tam sayı olmalıdır.').min(1, 'Sayfa 1 ya da daha büyük olmalıdır.').max(1_000_000, 'Sayfa çok büyük.').default(1),
  adet: z.coerce.number({ error: 'Adet sayı olmalıdır.' }).int('Adet tam sayı olmalıdır.').min(1, 'Adet en az 1 olmalıdır.').max(200, 'Adet en fazla 200 olabilir.').default(50),
});
const ImportQuery = z.object({ onizleme: bool, eksikleriPasiflestir: bool });

const tooLarge = (): HttpError => new HttpError(413, 'dosya_cok_buyuk', `Dosya en fazla ${MAX_IMPORT_BYTES / MB} MB olabilir.`);
const noFile = (message: string): HttpError => new HttpError(400, 'gecersiz_dosya', message);

// The raw body, a little over the file limit so a multipart envelope around a 5 MB file still fits; the
// file itself is measured after.
const rawBody = express.raw({ type: () => true, limit: MAX_IMPORT_BYTES + 256 * 1024 });
const readBody: RequestHandler = (req, res, next) => {
  rawBody(req, res, (err?: unknown) => {
    next((err as { type?: unknown } | undefined)?.type === 'entity.too.large' ? tooLarge() : err);
  });
};

/** The uploaded file: the raw body, or the "dosya" field of a multipart body. */
async function importFile(req: Request): Promise<Buffer> {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw noFile('Excel dosyası gönderilmedi.');
  let file = body;
  const type = req.headers['content-type'] ?? '';
  if (type.toLowerCase().startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await new globalThis.Request('http://127.0.0.1/', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) }).formData();
    } catch {
      throw noFile('multipart/form-data gövdesi çözümlenemedi.');
    }
    const part = form.get('dosya');
    if (!(part instanceof File)) throw noFile('Formda "dosya" alanında bir Excel dosyası bulunamadı.');
    file = Buffer.from(await part.arrayBuffer());
  }
  if (file.length > MAX_IMPORT_BYTES) throw tooLarge();
  return file;
}

/** Content-Disposition for a download: an ASCII name for old clients and the real one in filename*. */
export function attachment(name: string): string {
  const ascii = name
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendXlsx(res: Response, out: { readonly file: Buffer; readonly fileName: string }): void {
  res
    .status(200)
    .set({
      'Content-Type': XLSX_MIME,
      'Content-Length': String(out.file.length),
      'Content-Disposition': attachment(out.fileName),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    .end(out.file);
}

const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export function definitionRouter(deps: DefinitionDeps): Router {
  const r = express.Router();
  const { db } = deps;
  const admin = requireRole('yonetici');
  const isAdmin = (res: Response): boolean => userOf(res).rol === 'yonetici';

  const exportRoute = (def: (req: Request) => Promise<ListDef>) =>
    handle(async (req, res) => {
      sendXlsx(res, await exportList(db, await def(req)));
    });
  const importRoute = (def: (req: Request) => Promise<ListDef>) =>
    handle(async (req, res) => {
      const q = parse(ImportQuery, req.query);
      const list = await def(req);
      const file = await importFile(req);
      res.json(await importList(db, userOf(res), list, file, { preview: q.onizleme === true, deactivateMissing: q.eksikleriPasiflestir === true }));
    });

  /**
   * The routes of a list with records of its own: paged list, export, import, create, edit and delete.
   * `def` gets whether the caller is an administrator; only `listAccess` lets others in.
   */
  const crud = <T extends { readonly id: number }>(
    path: string,
    def: (req: Request, admin: boolean) => Promise<CrudDef<T>>,
    bodies: { readonly create: z.ZodType<Record<string, unknown>>; readonly patch: z.ZodType<Record<string, unknown>> },
    listAccess: RequestHandler = admin,
  ): void => {
    r.get(
      path,
      listAccess,
      handle(async (req, res) => {
        const filter = parse(PageQuery, req.query);
        const all = isAdmin(res);
        // Others see only active records.
        res.json(await listRecords(db, await def(req, all), all ? filter : { ...filter, aktif: true }));
      }),
    );
    r.get(`${path}/disa-aktar`, admin, exportRoute((req) => def(req, true)));
    r.post(`${path}/ice-aktar`, admin, readBody, importRoute((req) => def(req, true)));
    r.post(
      path,
      admin,
      handle(async (req, res) => {
        const list = await def(req, true);
        const created = await createRecord(db, userOf(res), list, parse(bodies.create, req.body) as Record<string, string | null | undefined>);
        res.status(201).location(`${req.baseUrl}${req.path}/${created.id}`).json(created);
      }),
    );
    r.patch(
      `${path}/:id`,
      admin,
      handle(async (req, res) => {
        const list = await def(req, true);
        res.json(await updateRecord(db, userOf(res), list, routeId(req.params.id), parse(bodies.patch, req.body) as Record<string, string | boolean | number | null | undefined>));
      }),
    );
    r.delete(
      `${path}/:id`,
      admin,
      handle(async (req, res) => {
        await deleteRecord(db, userOf(res), await def(req, true), routeId(req.params.id));
        res.status(204).end();
      }),
    );
  };

  crud('/organizasyonlar', async () => ORGANIZATIONS, { create: NewOrganization, patch: OrganizationPatch });
  crud('/masraf-merkezleri', async () => COST_CENTERS, { create: NewCostCenter, patch: CostCenterPatch });

  // Everyone reads the options of an active field; administrators also inactive fields and options.
  const options = async (req: Request, all: boolean) => {
    const anahtar = req.params.anahtar;
    return optionsOf(await findListField(db, typeof anahtar === 'string' ? anahtar : '', all));
  };
  const everyone: RequestHandler = (_req, _res, next) => next();
  crud('/alanlar/:anahtar/secenekler', options, { create: NewOption, patch: OptionPatch }, everyone);

  r.get('/kategoriler/disa-aktar', admin, exportRoute(async () => CATEGORIES));
  r.post('/kategoriler/ice-aktar', admin, readBody, importRoute(async () => CATEGORIES));
  r.delete(
    '/kategoriler/:id',
    admin,
    handle(async (req, res) => {
      await deleteCategory(db, userOf(res), routeId(req.params.id));
      res.status(204).end();
    }),
  );

  return r;
}
