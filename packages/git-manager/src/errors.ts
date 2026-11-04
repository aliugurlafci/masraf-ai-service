// Typed git-manager errors (contract §2.6, codes from §9.6).
import { OrcError } from '@orc/shared';

type OrcErrorOptions = ConstructorParameters<typeof OrcError>[2];

/** 'git_failed'; details {operation, exitCode, stderrTail}. */
export class GitError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('git_failed', message, options);
  }
}

/** 'git_timeout' */
export class GitTimeoutError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('git_timeout', message, options);
  }
}

/** 'git_ref_not_found' */
export class GitRefNotFoundError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('git_ref_not_found', message, options);
  }
}

/** 'git_repo_invalid' */
export class GitRepoInvalidError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('git_repo_invalid', message, options);
  }
}

/** 'workspace_quota_exceeded' */
export class WorkspaceQuotaError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('workspace_quota_exceeded', message, options);
  }
}

/** 'insufficient_disk_space' */
export class InsufficientDiskSpaceError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('insufficient_disk_space', message, options);
  }
}
