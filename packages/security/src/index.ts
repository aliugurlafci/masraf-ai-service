export {
  PathEscapeError,
  PromptTooLargeError,
  ToolPolicyError,
  UnsafeArgumentError,
} from './errors.js';
export {
  normalizeRepoRelativePath,
  normalizeWorktreeRelativePath,
  realpathWithin,
  resolveWithin,
} from './paths.js';
export { assertSafeArgv, isCommitSha, isSafeRefName, validateTestCommand } from './argv.js';
export type { ScryptParams } from './hashing.js';
export {
  DEFAULT_PASSWORD_HASH_CONCURRENCY,
  DEFAULT_SCRYPT_PARAMS,
  dummyPasswordVerify,
  generateCsrfToken,
  generatePat,
  generateSessionToken,
  hashPassword,
  setPasswordHashConcurrency,
  sha256,
  timingSafeEqualStr,
  validatePasswordPolicy,
  verifyPassword,
} from './hashing.js';
export type { SecretRegistry, StreamMasker } from './masking.js';
export {
  createSecretRegistry,
  createStreamMasker,
  maskObject,
  maskText,
  REDACT_KEYS,
  SECRET_VALUE_PATTERNS,
} from './masking.js';
export {
  buildChildEnv,
  CLAUDE_ENV_ALLOWLIST,
  GIT_ENV_ALLOWLIST,
  TEST_ENV_ALLOWLIST,
  WINDOWS_BASE_ENV,
} from './env.js';
export type { EffectiveToolPolicy, ToolPolicyOptions } from './tool-policy.js';
export {
  computeToolPolicy,
  PLATFORM_ALLOWED_RULE_PATTERNS,
  PLATFORM_BUILTIN_TOOLS,
  PLATFORM_DISALLOWED_RULES,
  validateAgentToolRules,
} from './tool-policy.js';
export { sanitizeUntrustedText, utf8ByteLength } from './prompt.js';
