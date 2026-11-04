# ADR-0014: Server-side sessions, PATs and scrypt password hashing

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Browser auth must work with EventSource (cannot send headers), support immediate revocation and audit, and avoid storing secrets in localStorage. Automation clients need tokens.

## Decision
Opaque 32-byte session token in an `HttpOnly; SameSite=Strict; Secure` cookie (`__Host-orc_sid`); its SHA-256 is stored in AuthSessions with idle (2 h) and absolute (12 h) expiry; CSRF double-submit header `X-CSRF-Token` is checked against the session's token, plus an Origin check. PATs `orc_pat_<43 chars>` are hashed in ApiTokens (optionally read-only). Passwords use node:crypto scrypt (N=2^17, r=8, p=1, 16-byte salt, params embedded), `timingSafeEqual`, lockout after 5 failures.

## Consequences
Instant revocation with a per-request indexed lookup; no native dependencies.

## Alternatives considered
JWT (no revocation without a deny-list, token in JS-visible storage for SSE); argon2 (native module build on Windows/Debian slim); bcrypt (72-byte input limit, native).

## Rollback path
Replace the auth middleware with another scheme; repositories and audit stay.
