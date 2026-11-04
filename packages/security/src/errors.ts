import { OrcError } from '@orc/shared';

interface SecurityErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** A user/DB-derived path resolved outside its root (lexically or via symlink). Internal code `path_escape`. */
export class PathEscapeError extends OrcError {
  constructor(message = 'Path escapes its root directory', options?: SecurityErrorOptions) {
    super('path_escape', message, options);
    this.name = 'PathEscapeError';
  }
}

/** A process argument violated argv safety rules. Internal code `unsafe_argument`. */
export class UnsafeArgumentError extends OrcError {
  constructor(message = 'Unsafe process argument', options?: SecurityErrorOptions) {
    super('unsafe_argument', message, options);
    this.name = 'UnsafeArgumentError';
  }
}

/** An agent tool rule is outside the platform allowlist. Code `tool_not_allowed` (422). */
export class ToolPolicyError extends OrcError {
  constructor(message = 'Tool rule not allowed', options?: SecurityErrorOptions) {
    super('tool_not_allowed', message, options);
    this.name = 'ToolPolicyError';
  }
}

/** The assembled prompt exceeds the configured byte budget. Code `prompt_too_large` (422). */
export class PromptTooLargeError extends OrcError {
  constructor(message = 'Prompt too large', options?: SecurityErrorOptions) {
    super('prompt_too_large', message, options);
    this.name = 'PromptTooLargeError';
  }
}

/** Input validation failure raised by security validators (`validation_failed`, 400). */
export function validationFailed(field: string, message: string): OrcError {
  return new OrcError('validation_failed', message, { details: { field } });
}
