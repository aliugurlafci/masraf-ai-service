import { OrcError } from '@orc/shared';

interface ClaudeProbeErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** The Claude CLI is missing, too old or lacks a required flag (§10.9). Code `claude_probe_failed`. */
export class ClaudeProbeError extends OrcError {
  constructor(message = 'Claude CLI probe failed', options?: ClaudeProbeErrorOptions) {
    super('claude_probe_failed', message, options);
    this.name = 'ClaudeProbeError';
  }
}
