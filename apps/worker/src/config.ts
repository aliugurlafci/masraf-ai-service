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
  };
}

export function claudeRunnerConfig(c: WorkerConfig, platform: HostPlatform): ClaudeRunnerConfig {
  return {
    bin: c.claudeBin,
    binPrefixArgs: c.claudeBinPrefixArgs,
    bare: c.claudeBare,
    claudeHomeRoot: c.claudeHomeRoot,
    apiKey: c.anthropicApiKey ?? null,
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
