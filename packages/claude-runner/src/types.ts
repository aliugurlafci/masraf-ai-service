// Public types of @orc/claude-runner (contract §2.8, §10).
import type {
  ClaudeInitEvent,
  ClaudeResultEvent,
  Clock,
  Effort,
  ParsedClaudeLine,
  Uuid,
} from '@orc/shared';
import type { Env, HostPlatform, KillResult, LaunchLease, ProcessLauncher } from '@orc/shared/node';
import type { EffectiveToolPolicy, SecretRegistry } from '@orc/security';
import type { Logger } from '@orc/logger';

export interface ClaudeProxyConfig {
  https: string | null;
  http: string | null;
  noProxy: string | null;
  /** EGRESS_PROXY_TOKEN: injected as `orc:<token>` credentials into the HTTPS proxy URL (§10.3). */
  token: string | null;
}

export interface ClaudeRunnerConfig {
  bin: string;
  binPrefixArgs: readonly string[];
  bare: boolean;
  /** HOME / CLAUDE_CONFIG_DIR are per workspace below this root (§10.3). */
  claudeHomeRoot: string;
  apiKey: string | null;
  proxy: ClaudeProxyConfig;
  killGraceMs: number;
  initTimeoutMs: number;
  maxOutputBytes: number;
  maxLineBytes: number;
  cbmCacheRoot: string;
  platform: HostPlatform;
  workerId: string;
  /** CLAUDE_INIT_EXTRA_TOOLS */
  initExtraTools: readonly string[];
}

/** `resume` always adds `--fork-session`. */
export type ClaudeSessionSpec =
  | { kind: 'new'; sessionId: Uuid }
  | { kind: 'resume'; resumeSessionId: string };

export type AbortReason =
  | 'cancel'
  | 'timeout'
  | 'worker_shutdown'
  | 'quota'
  | 'output_limit'
  | 'security_violation';

export interface ClaudeRunRequest {
  attemptId: Uuid;
  taskId: Uuid;
  workspaceId: Uuid;
  /** Worktree realpath (`realpathWithin(WORKSPACES_ROOT, workspace.path)`). */
  cwd: string;
  metaDir: string;
  tmpDir: string;
  lease: LaunchLease;
  model: string;
  effort: Effort | null;
  tools: EffectiveToolPolicy;
  mcp: { configPath: string; cacheDir: string } | null;
  appendSystemPrompt: string;
  stdinPrompt: string;
  session: ClaudeSessionSpec;
  maxBudgetUsd: number | null;
  deadlineAt: Date;
  /** `signal.reason` is an {@link AbortReason}. */
  signal: AbortSignal;
}

export interface ClaudeRunHandlers {
  /** Awaited before stdin is written (PID persistence, §10.8). */
  onSpawn(p: { pid: number; pgid: number | null; startedAt: Date }): Promise<void>;
  onInit(init: ClaudeInitEvent, v: InitValidation): Promise<void>;
  /** `raw` is already masked. */
  onLine(p: ParsedClaudeLine, raw: string, lineNo: number): void;
  /** Masked. */
  onStderr(chunk: string): void;
}

export type ClaudeOutcome =
  | 'success'
  | 'result_error'
  | 'budget_exceeded'
  | 'exit_nonzero'
  | 'protocol_error'
  | 'init_timeout'
  | 'resume_failed'
  | 'security_violation'
  | 'timeout'
  | 'cancelled'
  | 'shutdown'
  | 'output_limit'
  | 'quota'
  | 'spawn_failed';

export type InitRule = 'permission_mode' | 'mcp_server' | 'tool' | 'cwd' | 'session_id' | 'hook_event';

export interface InitViolation {
  rule: InitRule;
  detail: string;
}

export interface InitValidation {
  ok: boolean;
  violations: InitViolation[];
  mcpConnected: boolean;
}

export interface ValidateInitExpectations {
  permissionMode: 'dontAsk';
  cwd: string;
  sessionId: string | null;
  builtinTools: readonly string[];
  /** CLAUDE_INTERNAL_TOOL_NAMES + CLAUDE_INIT_EXTRA_TOOLS */
  extraTools: readonly string[];
  mcpEnabled: boolean;
  platform: HostPlatform;
}

export interface ClaudeRunResult {
  outcome: ClaudeOutcome;
  exitCode: number | null;
  signal: string | null;
  sessionId: string | null;
  init: ClaudeInitEvent | null;
  result: ClaudeResultEvent | null;
  violation: InitViolation | null;
  outputBytes: number;
  durationMs: number;
  kill: KillResult | null;
}

export interface ClaudeProbeResult {
  ok: boolean;
  version: string | null;
  missingFlags: string[];
  permissionModes: string[];
}

export type PromptContinuation =
  | { kind: 'none' }
  | { kind: 'retry_continue'; additionalInstructions: string | null }
  | { kind: 'infra_resume' }
  | {
      kind: 'retry_fresh';
      additionalInstructions: string | null;
      /** `{{n}}` of the §10.10 continuation text (optional extension of the contract type). */
      attemptNo?: number;
      /** `{{previousReason}}` of the §10.10 continuation text (optional extension of the contract type). */
      previousReason?: string | null;
    };

export interface PromptInput {
  worktreePath: string;
  agent: { name: string; title: string; instructions: string | null };
  project: {
    name: string;
    description: string | null;
    defaultBranch: string;
    baseSha: string;
    branchName: string;
    claudeMd: string | null;
  };
  index: { available: boolean; indexName: string | null };
  task: {
    title: string;
    prompt: string;
    acceptanceCriteria: string | null;
    scope: string | null;
  };
  continuation: PromptContinuation;
  tests: { command: readonly string[] | null; timeoutSeconds: number };
  /** 16 lower-case hex chars, per attempt. */
  nonce: string;
  limits: { promptMaxBytes: number; claudeMdMaxBytes: number };
}

export interface BuiltPrompt {
  appendSystemPrompt: string;
  stdinPrompt: string;
  stdinBytes: number;
  claudeMdTruncated: boolean;
}

export interface ClaudeRunner {
  probe(): Promise<ClaudeProbeResult>;
  /** Excludes bin + prefix args. */
  buildArgv(r: ClaudeRunRequest): string[];
  buildEnv(r: ClaudeRunRequest): Record<string, string>;
  /** Never rejects except for programmer/input errors raised before spawn and handler failures. */
  run(r: ClaudeRunRequest, h: ClaudeRunHandlers): Promise<ClaudeRunResult>;
}

export interface ClaudeRunnerDeps {
  logger: Logger;
  secrets: SecretRegistry;
  launcher: ProcessLauncher;
  clock?: Clock;
  /** Source of inherited variables (PATH, CLAUDE_CODE_GIT_BASH_PATH, WINDOWS_BASE_ENV); default `process.env`. */
  env?: Env;
}
