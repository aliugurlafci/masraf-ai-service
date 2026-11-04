# Orc architecture overview

Binding details live in [contract.md](contract.md); section numbers below refer to it.

## Components

```mermaid
flowchart LR
  subgraph edge[edge network]
    WEB[web<br/>nginx-unprivileged + React SPA<br/>HTTPS 8443]
  end
  subgraph frontend[frontend network - internal]
    API[api<br/>Express 5, SSE, auth, RBAC]
  end
  subgraph backend[backend network - internal]
    MSSQL[(MSSQL<br/>schema orc, TLS)]
    REDIS[(Redis<br/>BullMQ, streams, pub/sub)]
    WORKER[worker<br/>BullMQ workers + orchestrator + git]
  end
  subgraph sandbox[sandbox network - internal]
    RUNNER[runner<br/>launcher, per-lease uids, rlimits]
    PROXY[egress-proxy<br/>token + CONNECT allow-list]
  end
  subgraph runnerproc[runner container - untrusted processes]
    CLAUDE[claude CLI<br/>--bare, dontAsk]
    CBM[codebase-memory-mcp<br/>stdio]
    TESTS[project test command]
  end
  USER((Browser)) -->|HTTPS same-origin /api| WEB
  WEB -->|/api proxy| API
  API -->|orc_api_role| MSSQL
  API -->|enqueue, control pub, XREAD| REDIS
  WORKER -->|orc_worker_role| MSSQL
  WORKER -->|consume, XADD, sub| REDIS
  WORKER -->|unix socket protocol: lease, spawn| RUNNER
  RUNNER --> CLAUDE
  RUNNER --> CBM
  RUNNER --> TESTS
  CLAUDE -->|HTTPS_PROXY + token| PROXY
  PROXY -->|api.anthropic.com:443 only| INTERNET((Anthropic API))
  WORKER -.->|git read-only| PROJECTS[(./projects ro)]
  WORKER --> WS[(workspaces volume)]
  RUNNER --> WS
```

Package layering (§1.2): `shared <- security <- logger <- database <- task-manager <- project-manager <- api`; `git-manager, mcp-manager, claude-runner, task-manager <- orchestrator <- worker`; `sandbox <- worker, runner`; `web -> shared` only. Untrusted processes run only in the runner (§10.11, ADR-0024).

## Submit

```mermaid
sequenceDiagram
  participant U as Browser
  participant A as API
  participant D as MSSQL
  participant Q as Redis/BullMQ
  U->>A: POST /api/v1/tasks (Idempotency-Key, X-CSRF-Token)
  A->>D: tx: Task(created->queued) + Attempt#1(queued) + TaskEvents + AuditLogs + IdempotencyKeys(completed)
  A->>Q: add run-attempt jobId=attemptId (after commit)
  A->>Q: XADD status queued
  A-->>U: 202 Task + Location
  Note over A,Q: enqueue failure -> still 202; queued-reconciler re-adds within 60 s
```

## Execute

```mermaid
sequenceDiagram
  participant Q as BullMQ
  participant W as Worker pipeline
  participant D as MSSQL
  participant G as git
  participant M as codebase-memory-mcp
  participant C as claude CLI
  Q->>W: run-attempt
  W->>D: claimAttempt (CAS queued->preparing_workspace, DeadlineAt)
  W->>G: fetch mirror, worktree add -b orc/task-<k>-a<n>
  W->>D: -> indexing
  W->>M: index_repository(worktree, name orc-t-...)
  W->>D: -> running
  W->>C: spawn argv (§10.2), prompt on stdin
  C-->>W: stream-json (init validated fail-closed)
  W->>D: -> testing; run test argv; JUnit -> TestResults
  W->>D: -> reviewing
  W->>G: add/commit, name-status, numstat, patch, format-patch, merge-tree
  W->>M: re-index (fast) + detect_changes
  W->>D: ChangedFiles, AttemptPatches, MergeCheck; -> completed
```

## Live output

```mermaid
sequenceDiagram
  participant C as claude CLI
  participant W as Worker
  participant D as MSSQL
  participant R as Redis stream orc:task:<id>:events
  participant A as API SSE
  participant U as EventSource
  C-->>W: stdout NDJSON / stderr
  W->>R: XADD claude events (per line)
  W->>D: TaskLogs chunks (500 ms / 16 KB)
  W->>R: XADD log events (per chunk, same seq)
  U->>A: GET /tasks/:id/stream (Last-Event-ID)
  A->>A: authz (owner or task:read:any), connection caps
  A-->>U: status snapshot, replay XRANGE, live XREAD BLOCK, heartbeat 15 s
  A-->>U: end -> close (204 on reconnect when nothing new)
  Note over A,D: stream expired -> replay from TaskLogs (d- ids) then end
```

## Cancel

```mermaid
sequenceDiagram
  participant U as Browser
  participant A as API
  participant D as MSSQL
  participant R as Redis
  participant W as Worker
  U->>A: POST /tasks/:id/cancel
  alt created/queued
    A->>D: cancelPending tx (task+attempt cancelled)
    A->>R: remove waiting job, XADD status+end
    A-->>U: 200
  else active
    A->>D: requestCancel (CancelRequestedAt)
    A->>R: PUBLISH orc:control {cancel}
    A-->>U: 202
    R-->>W: cancel (or DB poll on heartbeat <= 10 s)
    W->>W: SIGTERM -pgid, grace, SIGKILL, verify (taskkill /T /F on Windows)
    W->>D: artefact capture, -> cancelled
    W->>R: status + end
  end
```

## Timeout

```mermaid
sequenceDiagram
  participant W as Worker
  participant C as claude / test process
  participant D as MSSQL
  W->>W: deadline timer (DeadlineAt = claim + TimeoutSeconds)
  W->>C: abort(timeout): kill sequence, verify no survivors
  W->>D: artefact capture, -> timed_out(timeout)
```

## Retry

```mermaid
sequenceDiagram
  participant U as Browser
  participant A as API
  participant D as MSSQL
  participant Q as BullMQ
  U->>A: POST /tasks/:id/retry {mode: fresh|continue}
  A->>D: createAttempt(user_retry): settled -> queued, Attempt n+1
  A->>Q: add run-attempt jobId=newAttemptId
  A-->>U: 202
  Note over Q: fresh = new worktree from base; continue = reuse workspace + --resume --fork-session
```

## Crash recovery

```mermaid
sequenceDiagram
  participant W1 as Worker (crashed)
  participant W2 as Other worker / restarted W1
  participant D as MSSQL
  participant Q as BullMQ
  W1--xD: heartbeats stop
  W2->>D: stale-attempt-recovery (LastHeartbeatAt older than 60 s) or startup own-attempt scan
  W2->>W2: orphan sweep (registry + ORC_ATTEMPT_ID marker)
  W2->>D: recoverInterruptedAttempt: old attempt interrupted; new attempt (infra_recovery, resume) or cancelled/timed_out/failed(recovery_limit_reached)
  W2->>Q: add run-attempt
  Q->>W2: run-attempt -> reuse worktree, claude --resume <session> --fork-session
```
