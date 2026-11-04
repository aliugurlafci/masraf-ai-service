# Known issues

## KI-001 — codebase-memory-mcp stdio session disconnects in long Claude Code sessions (development tooling)

- **Detected:** 2026-11-02, during Phase A (architecture). The MCP connection of the orchestrating Claude Code session and of several sub-agents was reported as "failed to connect / disconnected".
- **Diagnosis:**
  - `codebase-memory-mcp cli list_projects` and `cli index_status` work (exit 0).
  - The daemon log (`~/.cache/codebase-memory-mcp/logs/cbm-daemon.log`) shows healthy incremental re-indexing of `C-Workout-masraf-ai-service` (status=indexed) followed by `daemon.runtime_stopping reason=last_committed_client_disconnected`. The stdio MCP client side dropped; the index and the binary are healthy.
  - Configuration: user scope (`codebase-memory-mcp`, `C:/Users/ugur.lafci/.local/bin/codebase-memory-mcp.exe`) plus project `.mcp.json` (same command). The configuration is valid.
- **Workaround (in use):** call the same real tools through the local CLI of the same binary. Tool names and arguments are identical:
  - `codebase-memory-mcp cli --quiet search_graph '{"project":"C-Workout-masraf-ai-service","name_pattern":"resolveWithin"}'`
  - `codebase-memory-mcp cli --quiet index_repository '{"repo_path":"C:/Workout/masraf-ai-service","mode":"moderate"}'`
  - `codebase-memory-mcp cli --quiet detect_changes '{"project":"C-Workout-masraf-ai-service","scope":"impact"}'`
  - From PowerShell, escape the inner quotes (`'{\"project\":\"...\"}'`); from Git Bash, use plain single quotes.
- **Fix for interactive sessions:** run `/mcp` in Claude Code and reconnect `codebase-memory-mcp`, or restart the session.
- **Impact on the product:** none. The platform's `@orc/mcp-manager` starts a fresh stdio client for each operation, with a timeout (contract §12.1). It does not depend on a long-lived session.
- **Policy:** as long as the MCP stdio session is unavailable, no broad refactor is done without graph queries. Agents use the CLI fallback above.
