# ADR-0013: In-house CONNECT allow-list egress proxy

- Status: Accepted (2026-11-02); amended by ADR-0024 (proxy token, `sandbox` network only)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
Claude Code needs HTTPS to api.anthropic.com, but the worker must have no other network route (requirement §5.8, network egress restriction). Docker networks cannot filter by hostname.

## Decision
The worker sits only on the internal `backend` network. A small Node service `@orc/egress-proxy` (only `node:net/http/dns`) attached to `backend` and `egress` tunnels `CONNECT` requests whose host is in `EGRESS_ALLOWED_HOSTS` (default `api.anthropic.com`) and port in `EGRESS_ALLOWED_PORTS` (443), rejects private/loopback resolved IPs, refuses all plain HTTP except `/healthz`, and logs every decision. The worker sets `HTTPS_PROXY` for the Claude process only.

## Consequences
Auditable, minimal egress; test commands and MCP have no internet; adding hosts is a config change.

## Alternatives considered
Squid/tinyproxy container (another image to harden, separate config language); iptables rules (needs NET_ADMIN, host-specific); no restriction (violates requirements).

## Rollback path
Point `HTTPS_PROXY` at another forward proxy or remove the `egress` network; worker code is unchanged.
