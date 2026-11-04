# ADR-0020: helmet, pino-http, cookie and rate-limiter-flexible in the API

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The API needs security headers, structured request logging, cookie parsing for sessions, and Redis-backed rate limiting and login throttling. None of these are in the mandatory stack list.

## Decision
helmet (headers; CSP only for `/api/docs`), pino-http (request logs on the shared Pino logger), `cookie` (parse/serialize; already an Express dependency), rate-limiter-flexible (`RateLimiterRedis` on ioredis for route classes and per-username login failures).

## Consequences
Mature, small dependencies; limits are shared across API instances.

## Alternatives considered
express-rate-limit plus rate-limit-redis (two packages, weaker brute-force primitives); a hand-written limiter (risk); cookie-parser middleware (unneeded signing features).

## Rollback path
Each library sits behind one middleware module and can be replaced independently.
