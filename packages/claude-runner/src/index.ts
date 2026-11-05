// @orc/claude-runner — Claude CLI argv/env/prompt, stream-json, init validation, probe, kill (contract §2.8, §10).
export const PACKAGE_NAME = '@orc/claude-runner' as const;

export type {
  AbortReason,
  BuiltPrompt,
  ClaudeOutcome,
  ClaudeProbeResult,
  ClaudeProxyConfig,
  ClaudeRunHandlers,
  ClaudeRunner,
  ClaudeRunnerConfig,
  ClaudeRunnerDeps,
  ClaudeRunRequest,
  ClaudeRunResult,
  ClaudeSessionSpec,
  InitRule,
  InitValidation,
  InitViolation,
  PromptContinuation,
  PromptInput,
  ReviewedExtensions,
  ReviewedExtensionTable,
  ValidateInitExpectations,
} from './types';
export {
  CBM_MCP_SERVER_NAME,
  CLAUDE_FLAG_ALIASES,
  CLAUDE_HARDENED_SETTINGS,
  CLAUDE_INTERNAL_TOOL_NAMES,
  CLAUDE_MARKER_ENV,
  CLAUDE_PERMISSION_MODE,
  CLAUDE_PROBE_TIMEOUT_MS,
  CLAUDE_REQUIRED_FLAGS,
  CLAUDE_REVIEWED_EXTENSIONS,
  MCP_RESOURCE_TOOL_NAMES,
} from './constants';
export { ClaudeProbeError } from './errors';
export { buildClaudeArgv } from './argv';
export type { ClaudeLaunchEnv } from './env';
export {
  assertClaudeEnv,
  buildClaudeEnv,
  buildClaudeLaunchEnv,
  buildProbeEnv,
  proxyUrlWithToken,
} from './env';
export { claudeExtensionKey, validateInit } from './init-validation';
export type { ProbeEvaluation } from './probe';
export {
  evaluateClaudeProbe,
  helpHasFlag,
  parsePermissionModes,
  requiredClaudeFlags,
} from './probe';
export { buildLayeredPrompt } from './prompt';
export type { SplitLine } from './line-splitter';
export { LineSplitter } from './line-splitter';
export { outcomeForStopReason, toAbortReason } from './run';
export { claudeProcessKey, claudeRegistryEntry, sweepClaudeOrphans } from './orphans';
export { createClaudeRunner } from './runner';
