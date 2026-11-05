// Mapping of the validated worker configuration (contract §16.3) onto the library configurations.
import type { WorkerConfig } from '@orc/shared/node';
import type { HostPlatform } from '@orc/shared/node';
import type { GitManagerConfig } from '@orc/git-manager';
import type { McpManagerConfig } from '@orc/mcp-manager';
import type { ClaudeRunnerConfig } from '@orc/claude-runner';
import type { OrchestratorConfig } from '@orc/orchestrator';

export const hostPlatform = (): HostPlatform => (process.platform === 'win32' ? 'win32' : 'posix');

/** Masked stderr tail kept per git operation (§11.7). */
const GIT_STDERR_TAIL_CHARS = 4000;

export function gitManagerConfig(c: WorkerConfig, platform: HostPlatform): GitManagerConfig {
  return {
    gitBin: c.gitBin,
    projectsRoot: c.projectsRoot,
    workspacesRoot: c.workspacesRoot,
    hooksDir: c.gitHooksDir,
    opTimeoutMs: c.gitOpTimeoutMs,
    fetchTimeoutMs: c.gitFetchTimeoutMs,
    killGraceMs: c.claudeKillGraceMs,
    authorName: c.orcGitAuthorName,
    authorEmail: c.orcGitAuthorEmail,
    changedFilePatchMaxBytes: c.changedFilePatchMaxBytes,
    patchExportMaxBytes: c.patchExportMaxBytes,
    diffMaxFiles: c.diffMaxFiles,
    commitsMax: c.commitsMax,
    workspaceMaxBytes: c.workspaceMaxBytes,
    minFreeBytes: c.workspacesMinFreeBytes,
    sizeScanMaxEntries: c.workspaceSizeScanMaxEntries,
    stderrTailChars: GIT_STDERR_TAIL_CHARS,
    platform,
  };
}

export function mcpManagerConfig(c: WorkerConfig): McpManagerConfig {
  return {
    bin: c.codebaseMemoryMcpBin,
    binPrefixArgs: c.codebaseMemoryMcpBinPrefixArgs,
    cacheRoot: c.cbmCacheDir,
    workspacesRoot: c.workspacesRoot,
    logLevel: c.cbmLogLevel,
    connectTimeoutMs: c.mcpConnectTimeoutMs,
    callTimeoutMs: c.mcpCallTimeoutMs,
    indexTimeoutMs: c.mcpIndexTimeoutMs,
    detectTimeoutMs: c.mcpDetectTimeoutMs,
    resultMaxBytes: c.mcpResultMaxBytes,
    appVersion: c.appVersion,
    workerId: c.workerId,
    // ADR-0036 Decision 7: in api_key mode the key must not reach codebase-memory-mcp's environment.
    ...(c.claudeAuth.mode === 'api_key' ? { claudeEnvScrub: ['ANTHROPIC_API_KEY'] as const } : {}),
  };
}

export function claudeRunnerConfig(c: WorkerConfig, platform: HostPlatform): ClaudeRunnerConfig {
  return {
    bin: c.claudeBin,
    binPrefixArgs: c.claudeBinPrefixArgs,
    claudeHomeRoot: c.claudeHomeRoot,
    // ADR-0036: the mode and its single credential; the reviewed extension table is never configurable.
    auth: c.claudeAuth,
    proxy: {
      https: c.httpsProxy ?? null,
      http: c.httpProxy ?? null,
      noProxy: c.noProxy,
      token: c.egressProxyToken ?? null,
    },
    killGraceMs: c.claudeKillGraceMs,
    initTimeoutMs: c.claudeInitTimeoutMs,
    maxOutputBytes: c.claudeMaxOutputBytes,
    maxLineBytes: c.claudeMaxLineBytes,
    cbmCacheRoot: c.cbmCacheDir,
    platform,
    workerId: c.workerId,
    initExtraTools: c.claudeInitExtraTools,
  };
}

/** Yama setting that keeps same-uid tool children out of Claude's memory (ADR-0036 Decision 9). */
export const PTRACE_SCOPE_PATH = '/proc/sys/kernel/yama/ptrace_scope';

export interface ClaudeStartupWarning {
  event: 'claude_api_key_mode' | 'ptrace_scope_unprotected';
  message: string;
  /** ptrace_scope value read (null = missing or unreadable). */
  ptraceScope?: number | null;
}

/**
 * Startup warnings of the Claude credential setup, logged once by the worker:
 * - api_key mode (ADR-0036 Decision 7): the key still reaches Claude's Bash children; not recommended.
 * - local mode on Linux (Decision 9): Yama `ptrace_scope` missing or < 1 lets a same-uid tool child read
 *   the token from Claude's memory. Runner mode is checked by the runner itself.
 */
export async function claudeStartupWarnings(
  c: Pick<WorkerConfig, 'claudeAuth' | 'sandboxMode'>,
  o: { osPlatform: NodeJS.Platform; readPtraceScope: () => Promise<string> },
): Promise<ClaudeStartupWarning[]> {
  const out: ClaudeStartupWarning[] = [];
  if (c.claudeAuth.mode === 'api_key') {
    out.push({
      event: 'claude_api_key_mode',
      message:
        'CLAUDE_AUTH_MODE=api_key is not recommended: the API key reaches the Bash children of Claude (ADR-0036); prefer oauth',
    });
  }
  if (c.sandboxMode === 'local' && o.osPlatform === 'linux') {
    // Missing (no Yama), unreadable or unparsable counts as unprotected.
    const text = await o.readPtraceScope().catch(() => '');
    const m = /^\s*(\d+)\s*$/.exec(text);
    const scope = m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
    if (scope === null || scope < 1) {
      out.push({
        event: 'ptrace_scope_unprotected',
        message: `kernel.yama.ptrace_scope is ${scope === null ? 'missing' : String(scope)} (< 1): a same-uid process can read the Claude credential from memory; set it to 1 on the host`,
        ptraceScope: scope,
      });
    }
  }
  return out;
}

export function orchestratorConfig(c: WorkerConfig, platform: HostPlatform, cliVersion: string | null): OrchestratorConfig {
  return {
    workerId: c.workerId,
    workspacesRoot: c.workspacesRoot,
    projectsRoot: c.projectsRoot,
    claudeHomeRoot: c.claudeHomeRoot,
    heartbeatIntervalMs: c.heartbeatIntervalMs,
    quotaCheckEveryNthHeartbeat: c.quotaCheckEveryNHeartbeats,
    attemptStaleMs: c.attemptStaleMs,
    selfFenceAfterMs: c.selfFenceAfterMs,
    maxAutoRecoveries: c.maxAutoRecoveries,
    logFlushIntervalMs: c.logFlushIntervalMs,
    logFlushBytes: c.logFlushBytes,
    logBufferMaxBytes: c.logBufferMaxBytes,
    promptMaxBytes: c.promptMaxBytes,
    claudeMdMaxBytes: c.promptClaudeMdMaxBytes,
    mcpEnabled: c.mcpEnabled,
    mcpRequired: c.mcpRequired,
    testOutputMaxBytes: c.testOutputMaxBytes,
    junitMaxBytes: c.junitMaxBytes,
    testKillGraceMs: c.testKillGraceMs,
    artifactCaptureTimeoutMs: c.artifactCaptureTimeoutMs,
    workspaceRetentionHours: c.workspaceRetentionHours,
    branchRetentionDays: c.branchRetentionDays,
    retention: {
      logDays: c.logRetentionDays,
      gitOpsDays: c.gitopsRetentionDays,
      mcpOpsDays: c.mcpopsRetentionDays,
      patchDays: c.patchRetentionDays,
      batchSize: c.retentionBatchSize,
    },
    platform,
    cbmCacheRoot: c.cbmCacheDir,
    claudeBin: c.claudeBin,
    cliVersion,
    redisPrefix: c.redis.prefix,
    dbWriteRetryWindowMs: c.dbWriteRetryWindowMs,
    workspaceMaxBytes: c.workspaceMaxBytes,
    sizeScanMaxEntries: c.workspaceSizeScanMaxEntries,
    junitMaxCases: c.junitMaxCases,
    mcpIndexTimeoutMs: c.mcpIndexTimeoutMs,
  };
}
