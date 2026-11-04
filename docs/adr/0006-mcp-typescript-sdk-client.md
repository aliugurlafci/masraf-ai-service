# ADR-0006: @modelcontextprotocol/sdk for the codebase-memory-mcp client

- Status: Accepted (2026-11-02)
- Deciders: Solution Architecture Manager; GPM approval with contract v1.0.0
- Contract: `docs/architecture/contract.md`

## Context
The worker must drive codebase-memory-mcp (stdio server) for indexing and impact analysis and must discover tools via `tools/list` instead of guessing names.

## Decision
Use the official TypeScript SDK `Client` and `StdioClientTransport` (per-operation connection, explicit env, stderr piped, request timeouts with `resetTimeoutOnProgress`). The same SDK powers the fake server `tests/fixtures/fake-mcp`.

## Consequences
Protocol details (initialize, capabilities, progress) are handled by a maintained library; the transport spawns without a shell, so Windows binaries must be `.exe` or use the prefix-args form.

## Alternatives considered
Hand-rolled JSON-RPC over stdio (re-implements protocol and version negotiation); invoking the binary's CLI mode (not a stable contract).

## Rollback path
Implement `McpClientFactory` with a custom JSON-RPC client; mcp-manager callers are unaffected (contract §2.7).
