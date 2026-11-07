import express, { type Router } from 'express';
import { z } from 'zod';
import { toCsv } from '../expenses/export.ts';
import type { ExpenseService } from '../expenses/forms.ts';
import type { Invoice } from '../invoice/schema.ts';
import { FORM_STATES, MAX_INVOICES, type FormDurum } from '../expenses/rules.ts';
import { userOf } from './auth.ts';
import { amount, csvList, currency, id, isoDate, optionalText, parse, rate, recordId, routeId, text } from './validation.ts';

/** The form's whole invoice list, in order: at most MAX_INVOICES, each once. */
const invoiceIds = z
  .array(recordId, { error: 'Fatura listesi geçersiz.' })
  .max(MAX_INVOICES, `Bir masrafa en fazla ${MAX_INVOICES} fatura eklenebilir.`)
  .superRefine((ids, ctx) => {
    const twice = ids.findIndex((x, i) => ids.indexOf(x) !== i);
    if (twice >= 0) ctx.addIssue({ code: 'custom', message: 'Aynı fatura bir forma iki kez eklenemez.', path: [twice] });
  });

/** Base-currency equivalents by invoice id, for invoices in a third currency. */
const equivalents = z
  .record(recordId, amount('Karşılık'), { error: 'Karşılıklar fatura kimliğinden tutara bir eşleme olmalıdır.' })
  .refine((m) => Object.keys(m).length <= MAX_INVOICES, `En fazla ${MAX_INVOICES} karşılık girilebilir.`);

// A correction is the whole invoice as src/invoice/schema.ts defines it; blank text becomes null.
const blankToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const invoiceText = (label: string) =>
  z.preprocess(
    blankToNull,
    z
      .string({ error: `${label} metin ya da null olmalıdır.` })
      .trim()
      .max(500, `${label} en fazla 500 karakter olabilir.`)
      .nullable(),
  );
const invoiceNumber = (label: string) =>
  z.number({ error: `${label} sayı ya da null olmalıdır.` }).finite(`${label} geçerli bir sayı olmalıdır.`).nullable();
const realDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const invoiceDate = z.preprocess(
  blankToNull,
  z
    .string({ error: 'Fatura tarihi YYYY-AA-GG biçiminde ya da null olmalıdır.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fatura tarihi YYYY-AA-GG biçiminde olmalıdır.')
    .refine(realDate, 'Fatura tarihi geçerli bir tarih olmalıdır.')
    .nullable(),
);
const invoiceCurrency = z.preprocess(
  blankToNull,
  z
    .string({ error: 'Para birimi üç harfli ISO kodu ya da null olmalıdır.' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Para birimi üç harfli ISO kodu olmalıdır (TRY, USD, EUR).')
    .nullable(),
);
const invoiceCorrection: z.ZodType<Invoice> = z
  .object(
    {
      fatura: z
        .object(
          {
            faturaNo: invoiceText('Fatura no'),
            faturaTarihi: invoiceDate,
            saticiUnvan: invoiceText('Satıcı'),
            saticiVergiNo: invoiceText('Satıcı vergi no'),
            aliciUnvan: invoiceText('Alıcı'),
            aliciVergiNo: invoiceText('Alıcı vergi no'),
            paraBirimi: invoiceCurrency,
            araToplam: invoiceNumber('Ara toplam'),
            kdvToplam: invoiceNumber('KDV toplamı'),
            genelToplam: invoiceNumber('Genel toplam'),
          },
          { error: 'Fatura bilgileri eksik ya da geçersiz.' },
        )
        .strict(),
      kalemler: z
        .array(
          z
            .object(
              {
                aciklama: invoiceText('Kalem açıklaması'),
                miktar: invoiceNumber('Miktar'),
                birim: invoiceText('Birim'),
                birimFiyat: invoiceNumber('Birim fiyat'),
                kdvOrani: invoiceNumber('KDV oranı'),
                tutar: invoiceNumber('Kalem tutarı'),
              },
              { error: 'Kalem geçersiz.' },
            )
            .strict(),
          { error: 'Kalemler bir liste olmalıdır.' },
        )
        .max(200, 'Bir faturada en fazla 200 kalem olabilir.'),
    },
    { error: 'Düzeltme { fatura, kalemler } biçiminde olmalıdır.' },
  )
  .strict();

/** Corrections by invoice id; null removes the correction. */
const corrections = z
  .record(recordId, invoiceCorrection.nullable(), { error: 'Düzeltmeler fatura kimliğinden faturaya bir eşleme olmalıdır.' })
  .refine((m) => Object.keys(m).length <= MAX_INVOICES, `En fazla ${MAX_INVOICES} düzeltme gönderilebilir.`);

const formFields = {
  baslik: text('Başlık', 120),
  kategoriId: id('Kategori'),
  masrafTarihi: isoDate('Masraf tarihi'),
  tutar: amount('Tutar'),
  paraBirimi: currency.optional(),
  kur: rate.nullable().optional(),
  satici: optionalText('Satıcı', 200),
  aciklama: optionalText('Açıklama', 1000),
  faturaIdler: invoiceIds.optional(),
  yerelKarsiliklar: equivalents.optional(),
  faturaDuzeltmeleri: corrections.optional(),
};

const NewFormBody = z.object({ ...formFields, gonder: z.boolean().optional() }).strict();
const FormPatchBody = z
  .object({
    baslik: formFields.baslik.optional(),
    kategoriId: formFields.kategoriId.optional(),
    masrafTarihi: formFields.masrafTarihi.optional(),
    tutar: formFields.tutar.optional(),
    paraBirimi: formFields.paraBirimi,
    kur: formFields.kur,
    satici: formFields.satici,
    aciklama: formFields.aciklama,
    faturaIdler: formFields.faturaIdler,
    yerelKarsiliklar: formFields.yerelKarsiliklar,
    faturaDuzeltmeleri: formFields.faturaDuzeltmeleri,
  })
  .strict();

const states = csvList.pipe(z.array(z.enum(FORM_STATES, { error: 'Geçersiz durum filtresi.' })));

const ListQuery = z.object({
  kapsam: z.enum(['benim', 'tumu'], { error: 'Kapsam benim ya da tumu olmalıdır.' }).default('benim'),
  durum: states,
  q: z.string().max(100, 'Arama en fazla 100 karakter olabilir.').optional(),
  sayfa: z.coerce.number().int().min(1).max(100_000).default(1),
  adet: z.coerce.number().int().min(1).max(100).default(20),
});

const ExportQuery = z.object({
  durum: states,
  baslangic: isoDate('Başlangıç').optional(),
  bitis: isoDate('Bitiş').optional(),
});

const ApproveBody = z.object({ aciklama: optionalText('Açıklama', 500) });
const RejectBody = z.object({
  aciklama: z
    .string({ error: 'Ret gerekçesi girilmelidir.' })
    .trim()
    .min(3, 'Ret gerekçesi en az 3 karakter olmalıdır.')
    .max(500, 'Ret gerekçesi en fazla 500 karakter olabilir.'),
});
const ReassignBody = z.object({ onayId: id('Onay adımı'), yeniOnayciId: id('Yeni onaycı') });
const PreviewBody = z.object({
  tutar: amount('Tutar'),
  paraBirimi: currency.optional(),
  kur: rate.nullable().optional(),
  faturaIdler: invoiceIds.optional(),
  yerelKarsiliklar: equivalents.optional(),
  faturaDuzeltmeleri: corrections.optional(),
  akisId: id('Onay akışı').optional(),
});
const InboxQuery = z.object({ durum: z.enum(['bekleyen', 'karar'], { error: 'Durum bekleyen ya da karar olmalıdır.' }).default('bekleyen') });

/** Expense forms, approvals and the approval preview. Mounted after the session check. */
export function expenseRouter(expenses: ExpenseService): Router {
  const r = express.Router();

  r.get('/masraflar', async (req, res, next) => {
    try {
      const q = parse(ListQuery, req.query);
      res.json(await expenses.list(userOf(res), { ...q, durum: q.durum as FormDurum[] }));
    } catch (err) {
      next(err);
    }
  });

  r.get('/masraflar/disa-aktar', async (req, res, next) => {
    try {
      const q = parse(ExportQuery, req.query);
      const rows = await expenses.exportRows(userOf(res), q);
      const stamp = new Date().toISOString().slice(0, 10);
      res
        .type('text/csv; charset=utf-8')
        .attachment(`masraflar-${stamp}.csv`)
        .send(toCsv(rows));
    } catch (err) {
      next(err);
    }
  });

  r.post('/masraflar', async (req, res, next) => {
    try {
      const { gonder, ...input } = parse(NewFormBody, req.body);
      const form = await expenses.create(userOf(res), input, gonder === true);
      res.status(201).location(`/api/masraflar/${form.id}`).json(form);
    } catch (err) {
      next(err);
    }
  });

  r.get('/masraflar/:id', async (req, res, next) => {
    try {
      res.json(await expenses.detail(routeId(req.params.id), userOf(res)));
    } catch (err) {
      next(err);
    }
  });

  r.get('/masraflar/:id/pdf', async (req, res, next) => {
    try {
      const formId = routeId(req.params.id);
      const pdf = await expenses.pdf(formId, userOf(res));
      res.type('application/pdf').set('Content-Disposition', `attachment; filename="masraf-${formId}.pdf"`).send(pdf);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/masraflar/:id', async (req, res, next) => {
    try {
      res.json(await expenses.update(routeId(req.params.id), userOf(res), parse(FormPatchBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  const action = (path: string, run: (formId: number, req: express.Request, res: express.Response) => Promise<unknown>): void => {
    r.post(`/masraflar/:id/${path}`, async (req, res, next) => {
      try {
        res.json(await run(routeId(req.params.id), req, res));
      } catch (err) {
        next(err);
      }
    });
  };

  action('gonder', (formId, _req, res) => expenses.submit(formId, userOf(res)));
  action('geri-cek', (formId, _req, res) => expenses.withdraw(formId, userOf(res)));
  action('iptal', (formId, _req, res) => expenses.cancel(formId, userOf(res)));
  // The comment is optional, so a request without a body (req.body is then undefined) also approves.
  action('onayla', (formId, req, res) => expenses.approve(formId, userOf(res), parse(ApproveBody, req.body ?? {}).aciklama ?? null));
  action('reddet', (formId, req, res) => expenses.reject(formId, userOf(res), parse(RejectBody, req.body).aciklama));
  action('odendi', (formId, _req, res) => expenses.markPaid(formId, userOf(res)));
  action('devret', (formId, req, res) => {
    const body = parse(ReassignBody, req.body);
    return expenses.reassign(formId, userOf(res), body.onayId, body.yeniOnayciId);
  });

  r.get('/onaylar', async (req, res, next) => {
    try {
      res.json(await expenses.inbox(userOf(res), parse(InboxQuery, req.query).durum));
    } catch (err) {
      next(err);
    }
  });

  r.post('/onay-akisi/onizle', async (req, res, next) => {
    try {
      res.json(await expenses.preview(userOf(res), parse(PreviewBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
