// Route-class rate limiting with rate-limiter-flexible on Redis (contract §9.6, F8). Keys: `<P>:rl:<class>:<key>`
// (key = user id, else client IP). Redis unavailable => fail open (warn at most once per class per minute) for every
// class except `login`, which fails closed (503 dependency_unavailable) because it is the brute-force defence.
// Authentication itself is protected per client IP by the `auth` class (key `ip:<ip>`): requests without a valid
// credential count against it, and an exhausted IP is refused before any credential DB lookup (AuthFailureThrottle).
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { OrcError } from '@orc/shared';
import type { RateLimitClass } from '@orc/shared';
import { clientIp, state } from './context.js';
import { problem, sendProblem } from './problem.js';
import type { AppDeps, RateLimitRule } from './types.js';

/** §9.6 defaults (`login` is configured by LOGIN_IP_MAX / LOGIN_IP_WINDOW_SECONDS). */
export const DEFAULT_RATE_LIMITS: Readonly<Record<Exclude<RateLimitClass, 'login'>, RateLimitRule>> = Object.freeze({
  auth: { points: 30, durationSeconds: 60 },
  write: { points: 60, durationSeconds: 60 },
  task_create: { points: 30, durationSeconds: 60 },
  read: { points: 600, durationSeconds: 60 },
  stream: { points: 30, durationSeconds: 60 },
  public: { points: 120, durationSeconds: 60 },
});

const FAIL_OPEN_LOG_INTERVAL_MS = 60_000;
const REDIS_BOUND_MS = 2_000;

export type LimitOutcome =
  | { kind: 'allowed'; res: RateLimiterRes | null }
  | { kind: 'limited'; res: RateLimiterRes }
  | { kind: 'unavailable'; err: unknown };

export type ThrottleVerdict = { limited: false } | { limited: true; res: RateLimiterRes };

/**
 * Per-IP budget of unauthenticated requests (no, malformed, unknown, revoked or expired credential) on the `auth`
 * class. `check` runs before a credential DB lookup and only reads the counter, so valid credentials never consume
 * it; `record` counts one failure. Redis unavailable => a per-process in-memory counter with the same rule keeps the
 * lookups bounded (fail open: never a 503).
 */
export interface AuthFailureThrottle {
  check(req: Request): Promise<ThrottleVerdict>;
  record(req: Request): Promise<ThrottleVerdict>;
}

export function authFailureKey(req: Request): string {
  return `ip:${clientIp(req) ?? 'unknown'}`;
}

export interface RateLimiters {
  rule(c: RateLimitClass): RateLimitRule;
  consume(c: RateLimitClass, key: string): Promise<LimitOutcome>;
  /** Per-username login failure counter (§15.4). */
  readonly loginUser: RateLimiterRedis;
  /** Logs Redis outages of a class at most once per minute. */
  warnUnavailable(c: RateLimitClass, err: unknown): void;
  middleware(c: RateLimitClass): RequestHandler;
  readonly authFailures: AuthFailureThrottle;
}

async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OrcError('redis_unavailable', 'rate limiter timed out')), REDIS_BOUND_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function setRateLimitHeaders(res: Response, rule: RateLimitRule, r: RateLimiterRes): void {
  res.setHeader('RateLimit-Limit', String(rule.points));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, r.remainingPoints)));
  res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil(r.msBeforeNext / 1000))));
}

export function retryAfterSeconds(r: RateLimiterRes): number {
  return Math.max(1, Math.ceil(r.msBeforeNext / 1000));
}

/** Classes limited per client IP whatever the credential (§9.6: `login` 20/15 min per IP, `public` per IP). */
const PER_IP_CLASSES: ReadonlySet<RateLimitClass> = new Set<RateLimitClass>(['login', 'public']);

export function rateLimitKey(req: Request, res: Response, c: RateLimitClass): string {
  const auth = state(res).auth;
  if (auth.kind === 'authenticated' && !PER_IP_CLASSES.has(c)) return `u:${auth.user.id}`;
  return `ip:${clientIp(req) ?? 'unknown'}`;
}

/**
 * A request without a valid credential is refused by a route that needs auth (or by the anonymous CSRF/Origin check):
 * it counts against the client IP's `auth` budget unless its failed credential lookup already did. Exhausted budget
 * => 429 rate_limited (+ RateLimit-*, Retry-After) and true; otherwise false (the caller answers 401/403).
 */
export async function refuseExhaustedAuthBudget(req: Request, res: Response, limiters: RateLimiters): Promise<boolean> {
  const s = state(res);
  let limited = s.authThrottle?.limited ?? null;
  if (limited === null && s.authThrottle?.counted !== true) {
    const verdict = await limiters.authFailures.record(req);
    limited = verdict.limited ? verdict.res : null;
    s.authThrottle = { counted: true, limited };
  }
  if (limited === null) return false;
  setRateLimitHeaders(res, limiters.rule('auth'), limited);
  sendProblem(req, res, problem('rate_limited', undefined, retryAfterSeconds(limited)));
  return true;
}

export function createRateLimiters(deps: AppDeps): RateLimiters {
  const prefix = deps.config.redis.prefix;
  const rules: Record<RateLimitClass, RateLimitRule> = {
    ...DEFAULT_RATE_LIMITS,
    login: { points: deps.config.loginIpMax, durationSeconds: deps.config.loginIpWindowSeconds },
    ...deps.rateLimits,
  };
  const limiters = new Map<RateLimitClass, RateLimiterRedis>();
  const make = (keyPrefix: string, rule: RateLimitRule, blockDuration = 0): RateLimiterRedis =>
    new RateLimiterRedis({
      storeClient: deps.commandRedis,
      keyPrefix,
      points: rule.points,
      duration: rule.durationSeconds,
      blockDuration,
      rejectIfRedisNotReady: true,
    });
  for (const c of Object.keys(rules) as RateLimitClass[]) {
    limiters.set(c, make(`${prefix}:rl:${c}`, rules[c]));
  }
  const loginUser = make(
    `${prefix}:rl:login`,
    { points: deps.config.loginMaxFailures, durationSeconds: deps.config.loginLockSeconds },
    deps.config.loginLockSeconds,
  );
  const lastWarn = new Map<RateLimitClass, number>();

  const warnUnavailable = (c: RateLimitClass, err: unknown): void => {
    const now = Date.now();
    if (now - (lastWarn.get(c) ?? 0) < FAIL_OPEN_LOG_INTERVAL_MS) return;
    lastWarn.set(c, now);
    deps.logger.warn(
      { err, rateLimitClass: c, failOpen: c !== 'login' },
      c === 'login' ? 'rate limiter unavailable: failing closed' : 'rate limiter unavailable: failing open',
    );
  };

  const consume = async (c: RateLimitClass, key: string): Promise<LimitOutcome> => {
    const limiter = limiters.get(c);
    if (limiter === undefined) return { kind: 'allowed', res: null };
    try {
      return { kind: 'allowed', res: await bounded(limiter.consume(key)) };
    } catch (err) {
      if (err instanceof RateLimiterRes) return { kind: 'limited', res: err };
      return { kind: 'unavailable', err };
    }
  };

  const authRule = rules.auth;
  const authFallback = new RateLimiterMemory({ points: authRule.points, duration: authRule.durationSeconds });
  const exhausted = (r: RateLimiterRes | null): ThrottleVerdict =>
    r !== null && r.consumedPoints >= authRule.points ? { limited: true, res: r } : { limited: false };
  const authFailures: AuthFailureThrottle = {
    async check(req) {
      const key = authFailureKey(req);
      const limiter = limiters.get('auth');
      if (limiter === undefined) return { limited: false };
      try {
        return exhausted(await bounded(limiter.get(key)));
      } catch (err) {
        warnUnavailable('auth', err);
        return exhausted(await authFallback.get(key));
      }
    },
    async record(req) {
      const key = authFailureKey(req);
      const outcome = await consume('auth', key);
      if (outcome.kind === 'limited') return { limited: true, res: outcome.res };
      if (outcome.kind === 'allowed') return { limited: false };
      warnUnavailable('auth', outcome.err);
      try {
        await authFallback.consume(key);
        return { limited: false };
      } catch (err) {
        if (err instanceof RateLimiterRes) return { limited: true, res: err };
        throw err;
      }
    },
  };

  return {
    rule: (c) => rules[c],
    consume,
    loginUser,
    warnUnavailable,
    authFailures,
    middleware(c) {
      const rule = rules[c];
      return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const outcome = await consume(c, rateLimitKey(req, res, c));
        if (outcome.kind === 'allowed') {
          if (outcome.res !== null) setRateLimitHeaders(res, rule, outcome.res);
          next();
          return;
        }
        if (outcome.kind === 'limited') {
          setRateLimitHeaders(res, rule, outcome.res);
          const retry = retryAfterSeconds(outcome.res);
          sendProblem(req, res, problem(c === 'login' ? 'login_throttled' : 'rate_limited', undefined, retry));
          return;
        }
        warnUnavailable(c, outcome.err);
        if (c === 'login') {
          sendProblem(req, res, problem('dependency_unavailable', undefined, 5));
          return;
        }
        next();
      };
    },
  };
}
