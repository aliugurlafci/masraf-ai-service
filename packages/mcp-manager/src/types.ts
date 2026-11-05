// Public types of @orc/mcp-manager (contract §2.7).
import type { ChangedFileInput, Clock, IndexMode, McpOperationKind, Uuid } from '@orc/shared';
import type { LaunchLease, ProcessLauncher } from '@orc/shared/node';
import type { Logger } from '@orc/logger';
import type { McpErrorCode } from './errors';

export interface McpManagerConfig {
  /** CODEBASE_MEMORY_MCP_BIN (win32: an .exe, or an interpreter with the script in binPrefixArgs). */
  bin: string;
  /** CODEBASE_MEMORY_MCP_BIN_PREFIX_ARGS. */
  binPrefixArgs: readonly string[];
  /** CBM_CACHE_DIR root; scopes live under `p/<projectId>` and `w/<workspaceId>`. */
  cacheRoot: string;
  /** WORKSPACES_ROOT; every scope path must lie inside it. */
  workspacesRoot: string;
  /** CBM_LOG_LEVEL passed to the server. */
  logLevel: string;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  indexTimeoutMs: number;
  detectTimeoutMs: number;
  resultMaxBytes: number;
  /** APP_VERSION, sent as the MCP client version (§12.1). Default '0.0.0-dev'. */
  appVersion?: string;
  /** WORKER_ID, used for internally acquired launcher leases. Default `<hostname>-<pid>`. */
  workerId?: string;
  /** ADR-0036 item 7: names given an empty value in Claude's mcp.json `env` (api_key mode). Only this name is allowed. */
  claudeEnvScrub?: ReadonlyArray<'ANTHROPIC_API_KEY'>;
}

export interface McpToolInfo {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
}

export interface McpToolResult {
  isError: boolean;
  structured: unknown;
  text: string | null;
}

export interface McpSession {
  readonly serverVersion: string | null;
  listTools(): Promise<McpToolInfo[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    o: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<McpToolResult>;
  /** Terminates the server process. Idempotent. */
  close(): Promise<void>;
}

export interface McpClientFactory {
  connect(o: {
    env: Record<string, string>;
    cwd: string;
    lease: LaunchLease;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<McpSession>;
}

export interface McpOperationRecorder {
  start(o: {
    projectId: Uuid;
    taskId: Uuid | null;
    attemptId: Uuid | null;
    workspaceId: Uuid | null;
    kind: McpOperationKind;
    indexName: string;
    mode: IndexMode | null;
    existingOperationId?: Uuid;
  }): Promise<Uuid>;
  finish(id: Uuid, o: OperationOutcome): Promise<void>;
}

export interface OperationOutcome {
  status: 'succeeded' | 'failed' | 'skipped';
  nodeCount: number | null;
  edgeCount: number | null;
  result: unknown;
  errorCode: McpErrorCode | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface McpProbeResult {
  ok: boolean;
  serverVersion: string | null;
  tools: string[];
  missingTools: string[];
  schemaMismatches: string[];
}

export type IndexScope =
  | { kind: 'project'; projectId: Uuid; path: string }
  | {
      kind: 'workspace';
      projectId: Uuid;
      workspaceId: Uuid;
      taskId: Uuid;
      attemptId: Uuid;
      attemptNumber: number;
      path: string;
      keyLength: 8 | 12 | 32;
    };

export type WorkspaceScope = Extract<IndexScope, { kind: 'workspace' }>;

export type IndexKind = 'project_index' | 'task_index' | 'task_reindex';

/** One file of the worker-computed diff (git-manager `collectChanges`). */
export type ImpactFileChange = Pick<
  ChangedFileInput,
  'path' | 'oldPath' | 'changeType' | 'isBinary' | 'patch' | 'patchTruncated'
>;

/**
 * The diff `baseSha..headSha` computed by the worker (ADR-0035). Given to `detectChanges`, it replaces the
 * server-side `detect_changes` (which needs git inside the sandbox) by graph queries seeded with this diff.
 */
export interface ImpactChangeSet {
  headSha: string;
  files: readonly ImpactFileChange[];
  /** Changed files in the diff (`CollectedChanges.filesChanged`); `files` may be a prefix. */
  totalFiles: number;
  /** `CollectedChanges.truncatedFileList`: `files` stopped at DIFF_MAX_FILES. */
  truncated: boolean;
}

export interface McpManager {
  probe(): Promise<McpProbeResult>;
  /** lease: the attempt lease for workspace scopes (required); project scopes acquire `op-<operationId>` internally. */
  index(
    scope: IndexScope,
    o: {
      mode: IndexMode;
      kind: IndexKind;
      existingOperationId?: Uuid;
      lease?: LaunchLease;
      signal?: AbortSignal;
    },
  ): Promise<OperationOutcome & { operationId: Uuid }>;
  /**
   * impact_analysis. With `changes` the impact is derived from the worker's diff through graph tools
   * (`get_file_outline` + `trace_path`, no git in the server; ADR-0035); without it the server's
   * `detect_changes` resolves `baseSha` itself (§12.2), which needs a git repository readable by the server.
   */
  detectChanges(
    scope: WorkspaceScope,
    o: { baseSha: string; lease: LaunchLease; signal?: AbortSignal; changes?: ImpactChangeSet },
  ): Promise<OperationOutcome & { operationId: Uuid }>;
  /** delete_project + rm -rf cache dir; idempotent. */
  deleteIndex(scope: IndexScope, o?: { lease?: LaunchLease; signal?: AbortSignal }): Promise<void>;
  claudeMcpConfig(scope: WorkspaceScope): ClaudeMcpConfigFile;
  /**
   * ADR-0037: local mode verifies the runtime dir (and POSIX `os.tmpdir()`) Claude's MCP server will use;
   * runner mode is a no-op. Throws `PathEscapeError` (`path_escape`) or the fs error.
   */
  ensureClaudeMcpRuntime(scope: WorkspaceScope): Promise<void>;
  indexName(scope: IndexScope): string;
  cacheDir(scope: IndexScope): string;
}

export interface ClaudeMcpConfigFile {
  mcpServers: {
    'codebase-memory-mcp': {
      type: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

export interface McpManagerDeps {
  logger: Logger;
  factory: McpClientFactory;
  recorder: McpOperationRecorder;
  launcher: ProcessLauncher;
  clock?: Clock;
}

export interface SdkClientFactoryDeps {
  logger: Logger;
  launcher: ProcessLauncher;
}
