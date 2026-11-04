# ADR-0012: nginx-unprivileged serves the SPA and proxies /api

- Status: Accepted (2026-11-02); amended by ADR-0025 (TLS on 8443, 8080 redirects only)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The web container must run non-root with a read-only root filesystem and present a same-origin `/api` so cookies stay SameSite=Strict and no CORS is needed.

## Decision
Use `nginxinc/nginx-unprivileged:1.29-alpine` (port 8080, uid 101) serving the Vite build with SPA fallback, strict security headers and CSP, and `location /api/` proxying to `API_UPSTREAM` with buffering disabled for SSE (`proxy_buffering off`, long read timeout). Network refinement of brief D15: `frontend` (web <-> api) is `internal: true` and web additionally joins a bridge network `edge` that publishes 127.0.0.1:8088, so the API container has no outbound route.

## Consequences
Same-origin deployment; SSE works through the proxy; tmpfs needed for nginx temp paths.

## Alternatives considered
Serving static files from Express (couples web and API lifecycles, requirement §1.17); Caddy (TLS automation not needed locally).

## Rollback path
Replace the web image; the API is unaffected.
