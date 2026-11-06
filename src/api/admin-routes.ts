import express, { type Router } from 'express';
import { z } from 'zod';
import { createFlow, deleteFlow, getFlow, listFlows, setDefaultFlow, updateFlow } from '../approval/flow-store.ts';
import { STRATEGIES } from '../approval/flow.ts';
import { listAudit } from '../db/audit.ts';
import type { Db } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { createCategory, ICONS, listCategories, updateCategory } from '../expenses/categories.ts';
import { ROLES } from '../expenses/rules.ts';
import { createUser, getUser, listUsers, resetPassword, updateUser } from '../users/users.ts';
import { requireRole, userOf } from './auth.ts';
import { bool, email, id, limit, optionalText, parse, password, routeId, text } from './validation.ts';

export interface AdminDeps {
  readonly db: Db;
  readonly baseCurrency: string;
  readonly passwordMinLength: number;
}

const rol = z.enum(ROLES, { error: 'Rol calisan, muhasebe ya da yonetici olmalıdır.' });
const simge = z.enum(ICONS, { error: 'Geçersiz simge.' });

const flowAssignment = id('Onay akışı').nullable().optional();

const NewUserBody = z.object({
  eposta: email,
  adSoyad: text('Ad soyad', 120),
  rol,
  departman: optionalText('Departman', 80),
  sifre: password,
  onayAkisiId: flowAssignment,
});

const UserPatchBody = z
  .object({
    eposta: email.optional(),
    adSoyad: text('Ad soyad', 120).optional(),
    rol: rol.optional(),
    departman: optionalText('Departman', 80),
    aktif: z.boolean({ error: 'Aktif alanı true ya da false olmalıdır.' }).optional(),
    onayAkisiId: flowAssignment,
  })
  .strict();

const ResetBody = z.object({ yeniSifre: password });

const UsersQuery = z.object({ q: z.string().max(100).optional(), aktif: bool });
const AuditQuery = z.object({ adet: z.coerce.number().int().min(1).max(500).default(50) });

const FlowBody = z.object({
  ad: text('Akış adı', 80),
  strateji: z.enum(STRATEGIES, { error: 'Strateji "zincir" ya da "tek" olmalıdır.' }),
  adimlar: z
    .array(
      z.object({
        onayciId: id('Onaycı'),
        limit: limit('Onay limiti').nullable(),
      }),
      { error: 'Onay adımları liste olmalıdır.' },
    )
    .max(50, 'Onay akışında en fazla 50 adım olabilir.'),
});

const NewCategoryBody = z.object({ ad: text('Kategori adı', 60), simge: simge.optional() });
const CategoryPatchBody = z
  .object({
    ad: text('Kategori adı', 60).optional(),
    simge: simge.optional(),
    aktif: z.boolean({ error: 'Aktif alanı true ya da false olmalıdır.' }).optional(),
    sira: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const CategoriesQuery = z.object({ tumu: bool });

/** Users, audit log, approval flows and categories. Mounted after the session check. */
export function adminRouter(deps: AdminDeps): Router {
  const r = express.Router();
  const admin = requireRole('yonetici');

  r.get('/kullanicilar', admin, async (req, res, next) => {
    try {
      const q = parse(UsersQuery, req.query);
      res.json(await listUsers(deps.db, { q: q.q, aktif: q.aktif }));
    } catch (err) {
      next(err);
    }
  });

  r.post('/kullanicilar', admin, async (req, res, next) => {
    try {
      const body = parse(NewUserBody, req.body);
      const user = await createUser(deps.db, userOf(res), body, deps.passwordMinLength);
      res.status(201).location(`/api/kullanicilar/${user.id}`).json(user);
    } catch (err) {
      next(err);
    }
  });

  r.get('/kullanicilar/:id', admin, async (req, res, next) => {
    try {
      const user = await getUser(deps.db, routeId(req.params.id));
      if (user === null) throw notFound('Kullanıcı bulunamadı.');
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/kullanicilar/:id', admin, async (req, res, next) => {
    try {
      const body = parse(UserPatchBody, req.body);
      res.json(await updateUser(deps.db, userOf(res), routeId(req.params.id), body));
    } catch (err) {
      next(err);
    }
  });

  r.post('/kullanicilar/:id/sifre', admin, async (req, res, next) => {
    try {
      const body = parse(ResetBody, req.body);
      await resetPassword(deps.db, userOf(res), routeId(req.params.id), body.yeniSifre, deps.passwordMinLength);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.get('/denetim', admin, async (req, res, next) => {
    try {
      res.json(await listAudit(deps.db, parse(AuditQuery, req.query).adet));
    } catch (err) {
      next(err);
    }
  });

  r.get('/onay-akislari', admin, async (_req, res, next) => {
    try {
      res.json(await listFlows(deps.db, deps.baseCurrency));
    } catch (err) {
      next(err);
    }
  });

  r.post('/onay-akislari', admin, async (req, res, next) => {
    try {
      const flow = await createFlow(deps.db, userOf(res), parse(FlowBody, req.body), deps.baseCurrency);
      res.status(201).location(`/api/onay-akislari/${flow.id}`).json(flow);
    } catch (err) {
      next(err);
    }
  });

  r.get('/onay-akislari/:id', admin, async (req, res, next) => {
    try {
      res.json(await getFlow(deps.db, routeId(req.params.id), deps.baseCurrency));
    } catch (err) {
      next(err);
    }
  });

  r.put('/onay-akislari/:id', admin, async (req, res, next) => {
    try {
      res.json(await updateFlow(deps.db, userOf(res), routeId(req.params.id), parse(FlowBody, req.body), deps.baseCurrency));
    } catch (err) {
      next(err);
    }
  });

  r.post('/onay-akislari/:id/varsayilan', admin, async (req, res, next) => {
    try {
      res.json(await setDefaultFlow(deps.db, userOf(res), routeId(req.params.id), deps.baseCurrency));
    } catch (err) {
      next(err);
    }
  });

  r.delete('/onay-akislari/:id', admin, async (req, res, next) => {
    try {
      await deleteFlow(deps.db, userOf(res), routeId(req.params.id));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.get('/kategoriler', async (req, res, next) => {
    try {
      const all = parse(CategoriesQuery, req.query).tumu === true && userOf(res).rol === 'yonetici';
      res.json(await listCategories(deps.db, all));
    } catch (err) {
      next(err);
    }
  });

  r.post('/kategoriler', admin, async (req, res, next) => {
    try {
      const category = await createCategory(deps.db, userOf(res), parse(NewCategoryBody, req.body));
      res.status(201).json(category);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/kategoriler/:id', admin, async (req, res, next) => {
    try {
      res.json(await updateCategory(deps.db, userOf(res), routeId(req.params.id), parse(CategoryPatchBody, req.body)));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
