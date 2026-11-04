# ADR-0029: Contract 2.0.0 interface hardening from the A7 review

- Status: Accepted (2026-11-02, contract v2.0.0)
- Deciders: Solution Architecture Manager; GPM approval with contract v2.0.0
- Contract: `docs/architecture/contract.md` Changelog 2.0.0
- Review findings: F2, F3, F7, F8, F9, F10, F12, F16, T-M1..T-M9, T-m1..T-m12

## Context
The architecture review found interface defects that would fail at runtime (CHECK violations on session touch, unique violations on resume fallback, lost migration locks, truncation errors, OOM risks) or leak data (index operations of other users' tasks, bare tool rules), plus undefined behaviour (Redis outage, cancel/claim race, fencing).

## Decision
Breaking interface changes (major version 2.0.0):
- `computeToolPolicy` takes `worktreePath` and `cbmCacheRoot` and emits only worktree-scoped file rules; `validateAgentToolRules` validates agent profiles (F2, T-M1).
- `AuthSessionRepository.insert/touch` take TTL seconds and compute expiry in SQL (T-M3); `mapSqlError` separates 547 CHECK (500) from FK (409) and maps truncation/overflow to `validation_failed` (T-M2).
- `ClaudeSessionRepository.start` is an upsert with `RunCount`, called only from `onSpawn` (T-M5).
- `runMigrations` takes a transaction-owned applock per file (T-M4).
- `listByProject` / new `findRecent` take a viewer; task-scoped `result` is served only by `/tasks/:id/impact` (F3).
- `TaskService.retry` takes `ifMatch`; new `attempt`, `indexOperation`, `mcpStatus`, `listDeadLetters`, `redisMemory`; `MergeCheckResult` is a type alias (T-m5); the cancel race is defined (F16).
- JSON columns that DTOs can grow beyond 4000 characters are `NVARCHAR(MAX)` (T-M2); `CK_Tasks_Prompt` uses `DATALENGTH` and blank prompts are rejected (T-m4); `BigIdSchema` is range-checked (T-m3).
- Self-fencing, workspace lock and recovery precondition (F7); `DB_WRITE_RETRY_WINDOW_MS` default 30000.
- Redis-outage policy per rate class and SSE fallback (F8); dependency errors map to 503 via `toPublicError` (F9).
- Agent instructions <= 4096 UTF-8 bytes, Layer 1 <= 8192 bytes, win32 argv budget (F10, T-m7).
- Patch retention (`PATCH_RETENTION_DAYS`), `patchPurged`, `orc-db purge-audit` (F12).
- scrypt bounded to 128 MiB per hash, concurrency 2, API 1g (T-M6); Redis `maxmemory 400mb`, stream `MAXLEN ~ 1000`, stream text 2000 chars, `redisMemory` in `/system/queue` (T-M7). The 24 h settled-stream TTL of D7 is kept; GPM may shorten it (the DB replay makes it functionally optional).
- DLQ via `QueueEvents` 'failed' and a reconciler for `validating` projects (T-m1); chunk-safe masking (T-m12); Windows dev host rules (T-m8); MCP timeout without progress reset (T-m9).

## Consequences
Implementing teams follow contract 2.0.0; already implemented shared/security/logger code was updated in the same change. Package owners must align `package.json` dependencies and the ESLint/dependency-rules enforcement (T-M8).

## Alternatives considered
Keeping v1 signatures with workarounds in implementations (would leave the contract wrong and untestable).

## Rollback path
Contract 1.0.0 and the previous source remain recoverable from version control; no data migration has shipped yet.
