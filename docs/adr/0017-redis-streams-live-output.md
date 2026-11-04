# ADR-0017: Redis Streams plus MSSQL chunks for live output

- Status: Accepted (2026-11-02); amended by ADR-0029 (MAXLEN ~ 1000, stream text 2000 chars, Redis maxmemory)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Live output must reach browsers via SSE from any API instance, survive reconnects, and be stored durably in MSSQL in bounded chunks (requirement §5.4).

## Decision
The worker writes TaskLogs chunks (<= 4000 chars, flushed every 500 ms or 16 KB) and publishes events to `orc:task:<id>:events` (XADD MAXLEN ~ 5000, EXPIRE 24 h after settle). API SSE replays with XRANGE from Last-Event-ID and tails with XREAD BLOCK on a dedicated connection; expired streams are replayed from TaskLogs; lost Redis data falls back to DB tail mode.

## Consequences
Gap-free resume for recent tasks; durable history in MSSQL; one Redis connection per SSE client (capped).

## Alternatives considered
Pub/Sub only (no replay); polling MSSQL for all live output (load, latency); WebSockets (more infrastructure, not required).

## Rollback path
Switch SSE to DB tail mode only (already implemented as fallback).
