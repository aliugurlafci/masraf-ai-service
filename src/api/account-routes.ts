import express, { type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { LoginLimiter } from '../auth/login-limiter.ts';
import { burnPasswordCheck, verifyPassword } from '../auth/password.ts';
import { closeSession, openSession, type Istemci } from '../auth/sessions.ts';
import type { AuthSettings } from '../config.ts';
import type { Db } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import type { ExpenseService } from '../expenses/forms.ts';
import { changeOwnPassword, findLoginUser } from '../users/users.ts';
import { clearSessionCookie, sessionOf, setSessionCookie, userOf } from './auth.ts';
import { email, parse, password } from './validation.ts';

export interface AccountDeps {
  readonly db: Db;
  readonly auth: AuthSettings;
  readonly limiter: LoginLimiter;
  readonly expenses: ExpenseService;
}

const LoginBody = z.object({
  eposta: email,
  sifre: password,
  istemci: z.enum(['panel', 'mobil', 'api'], { error: 'İstemci panel, mobil ya da api olmalıdır.' }).default('api'),
});

const PasswordBody = z.object({
  mevcutSifre: password,
  yeniSifre: password,
});

const wrongLogin = (): HttpError => new HttpError(401, 'hatali_giris', 'E-posta veya şifre hatalı.');

/** POST /api/oturum: open, before the session check. */
export function loginHandler(deps: AccountDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const body = parse(LoginBody, req.body);
      const key = body.eposta;
      const wait = deps.limiter.lockedFor(key);
      if (wait > 0) {
        throw new HttpError(429, 'cok_fazla_deneme', `Çok fazla hatalı deneme yapıldı. ${Math.ceil(wait / 60_000)} dakika sonra tekrar deneyin.`);
      }
      const found = await findLoginUser(deps.db, body.eposta);
      if (found === null) {
        await burnPasswordCheck(body.sifre);
        deps.limiter.failed(key);
        throw wrongLogin();
      }
      if (!(await verifyPassword(body.sifre, found.sifreOzeti))) {
        deps.limiter.failed(key);
        throw wrongLogin();
      }
      deps.limiter.succeeded(key);
      if (!found.kullanici.aktif) throw new HttpError(403, 'hesap_pasif', 'Hesabınız pasif durumda. Yöneticinize başvurun.');
      const istemci: Istemci = body.istemci;
      const session = await openSession(deps.db, found.kullanici.id, istemci, deps.auth.sessionTtlMs);
      const kullanici = { ...found.kullanici, sonGiris: new Date().toISOString() };
      if (istemci === 'panel') {
        setSessionCookie(res, session.token, deps.auth.sessionTtlMs);
        res.json({ bitis: session.bitis, kullanici });
      } else {
        res.json({ token: session.token, bitis: session.bitis, kullanici });
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Routes about the signed-in user; mounted after the session check. */
export function accountRouter(deps: AccountDeps): Router {
  const r = express.Router();

  r.delete('/oturum', async (_req, res, next) => {
    try {
      await closeSession(deps.db, sessionOf(res).tokenOzeti);
      clearSessionCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.get('/ben', async (_req, res, next) => {
    try {
      const kullanici = userOf(res);
      res.json({ kullanici, bekleyenOnay: await deps.expenses.pendingCount(kullanici) });
    } catch (err) {
      next(err);
    }
  });

  r.put('/ben/sifre', async (req, res, next) => {
    try {
      const body = parse(PasswordBody, req.body);
      const session = sessionOf(res);
      await changeOwnPassword(deps.db, session.kullanici.id, body.mevcutSifre, body.yeniSifre, session.tokenOzeti, deps.auth.passwordMinLength);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.get('/ozet', async (_req, res, next) => {
    try {
      res.json(await deps.expenses.summary(userOf(res)));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
