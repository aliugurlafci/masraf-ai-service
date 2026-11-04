# malicious-tests fixture

Repository registered by `npm run test:compose` (scripts/compose-smoke.mjs) as the project `smoke-probes`. Its test
command (`fixture.json`: `node --test` with the JUnit reporter, report `junit.xml`) runs untrusted repository code in
the runner sandbox and tries to escape (contract §10.11 item 9):

- read `/run/secrets` and the secret files;
- find `DB_*`, `REDIS_*`, `MSSQL_*`, `EGRESS_*`, `*_FILE`, `ANTHROPIC_API_KEY`, `HTTP(S)_PROXY` in its environment;
- list and write sibling worktrees, `.repos`, `.orc`, `_base`, other Claude homes and MCP caches;
- open TCP connections to `mssql:1433` and `redis:6379` (plus api, worker and an external IP), the runner socket, and
  an egress CONNECT without credentials (must answer 407).

Every probe is one test case that passes only when the attempt is blocked; a JUnit failure names what was reachable.
Targets come from `orc-smoke-targets.json` (added at the repository root by the smoke script) merged with defaults
derived from the worktree location. Never run this outside the sandbox expecting a green result.
