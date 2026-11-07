import express, { type Router } from 'express';
import { z } from 'zod';
import { audit } from '../db/audit.ts';
import { transaction, type Db } from '../db/sql.ts';
import { conflict, notFound } from '../errors.ts';
import { enqueueTestMail, listMails, retryMail } from '../notifications/outbox.ts';
import { listNotifications, markAllRead, markRead, type NotifySettings } from '../notifications/store.ts';
import { requireRole, userOf } from './auth.ts';
import { bool, email, parse, routeId } from './validation.ts';

export interface NotificationDeps {
  readonly db: Db;
  readonly mail: NotifySettings;
}

const ListQuery = z.object({
  okunmamis: bool,
  sayfa: z.coerce.number().int().min(1).max(100_000).default(1),
  adet: z.coerce.number().int().min(1).max(100).default(20),
});

const TestBody = z.object({ alici: email.optional() });
const MailQuery = z.object({
  durum: z.enum(['bekliyor', 'gonderildi', 'hata', 'atlandi'], { error: 'Durum bekliyor, gonderildi, hata ya da atlandi olmalıdır.' }).optional(),
  adet: z.coerce.number().int().min(1).max(500).default(50),
});

const mailOff = () => conflict('mail_kapali', 'Mail gönderimi kapalı (MAIL_GONDERIM=kapali). Mail göndermek için .env dosyasında SMTP ayarlarını yapın.');

/** The user's own notifications, and the administrators' outgoing mail box. Mounted after the session check. */
export function notificationRouter(deps: NotificationDeps): Router {
  const r = express.Router();
  const admin = requireRole('yonetici');

  r.get('/bildirimler', async (req, res, next) => {
    try {
      const q = parse(ListQuery, req.query);
      res.json(await listNotifications(deps.db, userOf(res).id, { okunmamis: q.okunmamis === true, sayfa: q.sayfa, adet: q.adet }));
    } catch (err) {
      next(err);
    }
  });

  r.post('/bildirimler/hepsi-okundu', async (_req, res, next) => {
    try {
      await markAllRead(deps.db, userOf(res).id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/bildirimler/:id/okundu', async (req, res, next) => {
    try {
      if (!(await markRead(deps.db, userOf(res).id, routeId(req.params.id)))) throw notFound('Bildirim bulunamadı.');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/eposta/deneme', admin, async (req, res, next) => {
    try {
      const body = parse(TestBody, req.body);
      if (!deps.mail.mailEnabled) throw mailOff();
      const actor = userOf(res);
      const adres = body.alici ?? actor.eposta;
      const id = await transaction(deps.db, async (tx) => {
        const mailId = await enqueueTestMail(tx, adres, deps.mail.appUrl);
        await audit(tx, actor.id, 'eposta_deneme', `Deneme maili sıraya alındı: ${adres}`);
        return mailId;
      });
      res.status(202).json({ id });
    } catch (err) {
      next(err);
    }
  });

  r.get('/eposta', admin, async (req, res, next) => {
    try {
      res.json(await listMails(deps.db, parse(MailQuery, req.query)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/eposta/:id/yeniden', admin, async (req, res, next) => {
    try {
      const id = routeId(req.params.id);
      if (!deps.mail.mailEnabled) throw mailOff();
      const actor = userOf(res);
      await transaction(deps.db, async (tx) => {
        const result = await retryMail(tx, id);
        if (result.sonuc === 'yok') throw notFound('Mail bulunamadı.');
        if (result.sonuc === 'durum') throw conflict('gecersiz_durum', 'Yalnızca gönderilemeyen (hata durumundaki) mailler yeniden gönderilebilir.');
        await audit(tx, actor.id, 'eposta_yeniden', `#${id} yeniden sıraya alındı: ${result.adres ?? ''}`);
      });
      res.status(202).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}
