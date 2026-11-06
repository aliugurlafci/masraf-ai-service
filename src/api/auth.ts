import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { findSession, type ActiveSession } from '../auth/sessions.ts';
import type { Db } from '../db/sql.ts';
import { forbidden, HttpError } from '../errors.ts';
import type { Rol } from '../expenses/rules.ts';
import type { Kullanici } from '../users/users.ts';

export const SESSION_COOKIE = 'masraf_oturum';

const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'strict', path: '/' } as const;

/** The panel never sees the token: an HttpOnly cookie keeps it out of reach of page scripts. */
export function setSessionCookie(res: Response, token: string, ttlMs: number): void {
  res.cookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: ttlMs });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
}

/** Bearer token (mobile app, API clients) or the panel's HttpOnly cookie. */
export function tokenOf(req: Request): string | null {
  return bearerOf(req) ?? cookieOf(req);
}

function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

function cookieOf(req: Request): string | null {
  const cookies = req.headers.cookie;
  if (typeof cookies !== 'string') return null;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

const SESSION_KEY = 'oturum';

export function sessionOf(res: Response): ActiveSession {
  const s = res.locals[SESSION_KEY] as ActiveSession | undefined;
  if (s === undefined) throw new HttpError(401, 'oturum_gerekli', 'Oturum açmanız gerekiyor.');
  return s;
}

export const userOf = (res: Response): Kullanici => sessionOf(res).kullanici;

/** Requests a user who must change their password may still make. */
const PASSWORD_CHANGE_ALLOWED = new Set(['GET /api/ben', 'PUT /api/ben/sifre', 'DELETE /api/oturum']);

/** Every /api request except the open ones needs a session; sets res.locals.oturum. */
export function requireSession(db: Db, sessionTtlMs: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = tokenOf(req);
    if (token === null) {
      next(new HttpError(401, 'oturum_gerekli', 'Oturum açmanız gerekiyor.'));
      return;
    }
    findSession(db, token, sessionTtlMs).then(
      (session) => {
        if (session === null) {
          next(new HttpError(401, 'oturum_gerekli', 'Oturumunuz sona erdi. Lütfen yeniden giriş yapın.'));
          return;
        }
        res.locals[SESSION_KEY] = session;
        // Keep the browser's cookie as long-lived as the session it carries.
        if (session.uzatildi && bearerOf(req) === null) setSessionCookie(res, token, sessionTtlMs);
        const route = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, '');
        if (session.kullanici.sifreDegismeli && !PASSWORD_CHANGE_ALLOWED.has(route)) {
          next(new HttpError(403, 'sifre_degismeli', 'Devam etmek için önce şifrenizi değiştirin.'));
          return;
        }
        next();
      },
      (err: unknown) => next(err),
    );
  };
}

export function requireRole(...roles: Rol[]): RequestHandler {
  return (_req, res, next) => {
    next(roles.includes(userOf(res).rol) ? undefined : forbidden());
  };
}
