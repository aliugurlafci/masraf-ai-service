# ADR-0005: ioredis as the Redis client

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
BullMQ requires ioredis connections; the platform also needs Redis Streams (XADD/XREAD BLOCK), Pub/Sub, Lua scripts and a rate-limiter backend.

## Decision
Use ioredis (the version compatible with the pinned BullMQ 6) for every Redis access through `RedisFactory` (`@orc/task-manager`), with role-specific options (`maxRetriesPerRequest: null` for queue/worker/blocking/subscriber connections) and one dedicated connection per SSE reader.

## Consequences
Single client library and connection policy; blocking reads need dedicated connections (bounded by SSE caps).

## Alternatives considered
node-redis (not supported by BullMQ, would mean two clients); a hand-written RESP client (unjustified).

## Rollback path
Keep ioredis for BullMQ and move non-queue access to another client behind the same factory interfaces.
