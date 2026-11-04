# ADR-0025: TLS is terminated by the web container

- Status: Accepted (2026-11-02, contract v2.0.0); amends ADR-0012
- Deciders: Solution Architecture Manager; GPM approval with contract v2.0.0
- Contract: `docs/architecture/contract.md` §16.2, §16.6, §19, §20
- Review finding: F6

## Context
Production requires `COOKIE_SECURE=true` and the `__Host-orc_sid` cookie, and the overview shows HTTPS, but v1.0.0 published plain HTTP on 127.0.0.1:8088 with no certificate, TLS settings or HSTS. Browsers accept Secure cookies over HTTP only for loopback hosts, so remote users could not log in.

## Decision
nginx-unprivileged serves HTTPS on 8443 (TLS 1.2/1.3, Mozilla intermediate ciphers, session tickets off, HSTS `max-age=31536000`) with the compose secrets `web_tls_cert` / `web_tls_key`; port 8080 (published as 8088) only answers 301 to HTTPS. `scripts/generate-secrets.mjs` creates a local CA and a certificate for `WEB_SERVER_NAME` (default `localhost`) for local use; operators install their own certificate and set `WEB_BIND_ADDRESS` and `PUBLIC_ORIGIN` for remote access, or place their own TLS proxy in front that forwards HTTPS to 8443. Config validation: with `NODE_ENV=production`, `PUBLIC_ORIGIN` must be `https:` unless its host is `localhost`, `127.0.0.1` or `[::1]`. nginx overwrites `X-Forwarded-For` and the API runs with `TRUST_PROXY=1`.

## Consequences
Remote users get a working, encrypted, same-origin deployment; certificate rotation is an operator task (replace two secret files, restart web). Local development keeps Vite over HTTP (development config).

## Alternatives considered
Operator-provided reverse proxy only (leaves the default deployment non-functional for remote users); Caddy with ACME (needs internet egress for the web container).

## Rollback path
Serve HTTP only on loopback by publishing 8080 and setting `PUBLIC_ORIGIN=http://127.0.0.1:8088` (allowed for loopback hosts).
