// Ordered argv of the Claude CLI (contract §10.2). Only flags verified against the pinned CLI.
import { APPEND_SYSTEM_PROMPT_MAX_BYTES, EFFORT_LEVELS, GUID_REGEX } from '@orc/shared';
import type { HostPlatform } from '@orc/shared/node';
import {
  assertSafeArgv,
  PLATFORM_BUILTIN_TOOLS,
  PromptTooLargeError,
  ToolPolicyError,
  UnsafeArgumentError,
  utf8ByteLength,
} from '@orc/security';
import { CLAUDE_PERMISSION_MODE } from './constants';
import type { ClaudeRunRequest } from './types';

/** Model ids: no leading '-', no whitespace/control characters (`claude-x`, `x[1m]`, `arn:...:profile/x`). */
const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/[\]@-]{0,255}$/;
/** Session ids reported by the CLI (UUIDs); never an option-like value. */
const RESUME_SESSION_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_BUDGET_USD = 1_000_000;

export interface BuildArgvOptions {
  bare: boolean;
  platform: HostPlatform;
}

function unsafe(reason: string, message: string): UnsafeArgumentError {
  return new UnsafeArgumentError(message, { details: { reason } });
}

function assertRuleValues(rules: readonly string[], flag: string): void {
  for (const rule of rules) {
    // A value starting with '-' would be parsed by the CLI as an option (variadic flags stop there).
    if (typeof rule !== 'string' || rule.length === 0 || rule.startsWith('-')) {
      throw new ToolPolicyError('Invalid tool rule', { details: { flag } });
    }
  }
}

/** §10.2 rows 1-16 in order; ends with `assertSafeArgv(argv, {platform})`. Excludes bin + prefix args. */
export function buildClaudeArgv(r: ClaudeRunRequest, o: BuildArgvOptions): string[] {
  if (typeof r.model !== 'string' || !MODEL_REGEX.test(r.model)) {
    throw unsafe('invalid_model', 'Invalid model name');
  }
  if (r.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(r.effort)) {
    throw unsafe('invalid_effort', 'Invalid effort level');
  }
  const builtins = r.tools.builtinTools;
  if (
    builtins.length === 0 ||
    builtins.some((t) => !(PLATFORM_BUILTIN_TOOLS as readonly string[]).includes(t)) ||
    new Set(builtins).size !== builtins.length
  ) {
    throw new ToolPolicyError('Builtin tool list must be a non-empty subset of the platform tools', {
      details: { flag: '--tools' },
    });
  }
  assertRuleValues(r.tools.allowedRules, '--allowed-tools');
  if (r.tools.disallowedRules.length === 0) {
    throw new ToolPolicyError('Platform deny list must not be empty', {
      details: { flag: '--disallowed-tools' },
    });
  }
  assertRuleValues(r.tools.disallowedRules, '--disallowed-tools');
  if (r.mcp !== null && (typeof r.mcp.configPath !== 'string' || r.mcp.configPath.length === 0)) {
    throw unsafe('invalid_mcp_config_path', 'Invalid MCP config path');
  }
  const appendBytes = utf8ByteLength(r.appendSystemPrompt);
  if (appendBytes > APPEND_SYSTEM_PROMPT_MAX_BYTES) {
    throw new PromptTooLargeError('System prompt layer exceeds its byte budget', {
      details: { bytes: appendBytes, maxBytes: APPEND_SYSTEM_PROMPT_MAX_BYTES },
    });
  }

  const argv: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.bare) argv.push('--bare');
  argv.push('--setting-sources', 'user');
  argv.push('--model', r.model);
  if (r.effort !== null) argv.push('--effort', r.effort);
  argv.push('--permission-mode', CLAUDE_PERMISSION_MODE);
  argv.push('--tools', builtins.join(','));
  if (r.tools.allowedRules.length > 0) argv.push('--allowed-tools', ...r.tools.allowedRules);
  argv.push('--disallowed-tools', ...r.tools.disallowedRules);
  if (r.mcp !== null) argv.push('--mcp-config', r.mcp.configPath);
  argv.push('--strict-mcp-config');
  argv.push('--append-system-prompt', r.appendSystemPrompt);
  if (r.session.kind === 'new') {
    if (!GUID_REGEX.test(r.session.sessionId)) {
      throw unsafe('invalid_session_id', 'Invalid session id');
    }
    argv.push('--session-id', r.session.sessionId);
  } else {
    if (!RESUME_SESSION_REGEX.test(r.session.resumeSessionId)) {
      throw unsafe('invalid_resume_session_id', 'Invalid resume session id');
    }
    argv.push('--resume', r.session.resumeSessionId, '--fork-session');
  }
  if (r.maxBudgetUsd !== null) {
    if (
      !Number.isFinite(r.maxBudgetUsd) ||
      r.maxBudgetUsd < 0.01 ||
      r.maxBudgetUsd > MAX_BUDGET_USD
    ) {
      throw unsafe('invalid_max_budget', 'Invalid max budget');
    }
    argv.push('--max-budget-usd', r.maxBudgetUsd.toFixed(2));
  }
  assertSafeArgv(argv, { platform: o.platform });
  return argv;
}
