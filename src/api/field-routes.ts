import express, { type Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/sql.ts';
import { createField, createRule, deleteField, deleteRule, listFields, replaceRule, updateField } from '../definitions/fields.ts';
import { RECEIPT_TYPES } from '../expenses/field-rules.ts';
import { requireRole, userOf } from './auth.ts';
import { bool, id, optionalText, parse, routeId, text } from './validation.ts';

const flag = (label: string) => z.boolean({ error: `${label} true ya da false olmalıdır.` });

const NewFieldBody = z
  .object({
    ad: text('Alan adı', 60),
    tur: z.enum(RECEIPT_TYPES, { error: 'Tür liste, metin, uzun_metin, sayi ya da tarih olmalıdır.' }),
    zorunlu: flag('Zorunlu').optional(),
    aciklama: optionalText('Açıklama', 200),
  })
  .strict();

// tur, anahtar, duzey and sistem never change; they may come back with their current value (the
// service refuses another value with "Bu alanın … değiştirilemez.").
const FieldPatchBody = z
  .object({
    ad: text('Alan adı', 60).optional(),
    zorunlu: flag('Zorunlu').optional(),
    aktif: flag('Aktif').optional(),
    sira: z
      .number({ error: 'Sıra tam sayı olmalıdır.' })
      .int('Sıra tam sayı olmalıdır.')
      .min(-1_000_000, 'Sıra geçersiz.')
      .max(1_000_000, 'Sıra geçersiz.')
      .optional(),
    aciklama: optionalText('Açıklama', 200),
    tur: z.unknown().optional(),
    anahtar: z.unknown().optional(),
    duzey: z.unknown().optional(),
    sistem: z.unknown().optional(),
  })
  .strict();

const RuleBody = z
  .object({
    kosulAlan: z.string({ error: 'Koşul alanı girilmelidir.' }).min(1, 'Koşul alanı girilmelidir.').max(40, 'Koşul alanı bulunamadı.'),
    kosulDegerId: id('Koşul değeri'),
    hedefler: z
      .array(z.string({ error: 'Hedef bir alan anahtarı olmalıdır.' }).max(40, 'Bu alan bulunamadı.'), { error: 'Hedefler alan anahtarlarının listesi olmalıdır.' })
      .min(1, 'En az bir hedef alan seçin.')
      .max(40, 'Bir kuralın en fazla 40 hedefi olabilir.')
      .superRefine((keys, ctx) => {
        const twice = keys.findIndex((k, i) => keys.indexOf(k) !== i);
        if (twice >= 0) ctx.addIssue({ code: 'custom', message: 'Aynı alan iki kez seçilmiş.', path: [twice] });
      }),
  })
  .strict();

const FieldsQuery = z.object({ tumu: bool });

/** Receipt fields and required-field rules (docs/onay-sistemi.md, section 6, "Fiş alanları"). Mounted after the session check. */
export function fieldRouter(db: Db): Router {
  const r = express.Router();
  const admin = requireRole('yonetici');

  // Everyone reads the active fields; tumu=1 (inactive ones and their use) only counts for administrators.
  r.get('/alanlar', async (req, res, next) => {
    try {
      const all = parse(FieldsQuery, req.query).tumu === true && userOf(res).rol === 'yonetici';
      res.json(await listFields(db, all));
    } catch (err) {
      next(err);
    }
  });

  r.post('/alanlar', admin, async (req, res, next) => {
    try {
      res.status(201).json(await createField(db, userOf(res), parse(NewFieldBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.patch('/alanlar/:id', admin, async (req, res, next) => {
    try {
      res.json(await updateField(db, userOf(res), routeId(req.params.id), parse(FieldPatchBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.delete('/alanlar/:id', admin, async (req, res, next) => {
    try {
      await deleteField(db, userOf(res), routeId(req.params.id));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/alan-kurallari', admin, async (req, res, next) => {
    try {
      res.status(201).json(await createRule(db, userOf(res), parse(RuleBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.put('/alan-kurallari/:id', admin, async (req, res, next) => {
    try {
      res.json(await replaceRule(db, userOf(res), routeId(req.params.id), parse(RuleBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.delete('/alan-kurallari/:id', admin, async (req, res, next) => {
    try {
      await deleteRule(db, userOf(res), routeId(req.params.id));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}
