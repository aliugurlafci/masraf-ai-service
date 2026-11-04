import { UnsafeArgumentError, validationFailed } from './errors.js';

const MAX_ARG_BYTES = 32 * 1024;
const MAX_ARGV_TOTAL_BYTES = 64 * 1024;
/** CreateProcess limits the command line to 32 767 UTF-16 units; keep headroom for quoting/escapes. */
const MAX_WIN32_COMMAND_LINE_CHARS = 30_000;

/**
 * Every element is a string without NUL, <= 32 KiB (UTF-8); the whole argv (plus one separator
 * per element) <= 64 KiB. On win32 additionally the estimated command line (UTF-16 length of each
 * element + 3 for quotes and separator, doubled backslashes before quotes) <= 30 000 characters.
 * Throws {@link UnsafeArgumentError}; values are never echoed in errors.
 */
export function assertSafeArgv(
  argv: readonly string[],
  opts: { platform?: 'posix' | 'win32' } = {},
): void {
  if (!Array.isArray(argv)) {
    throw new UnsafeArgumentError('argv must be an array', { details: { reason: 'not_array' } });
  }
  let total = 0;
  argv.forEach((arg: unknown, index) => {
    if (typeof arg !== 'string') {
      throw new UnsafeArgumentError(`argv[${index}] is not a string`, {
        details: { index, reason: 'not_string' },
      });
    }
    if (arg.includes('\0')) {
      throw new UnsafeArgumentError(`argv[${index}] contains a NUL byte`, {
        details: { index, reason: 'nul_byte' },
      });
    }
    const bytes = Buffer.byteLength(arg, 'utf8');
    if (bytes > MAX_ARG_BYTES) {
      throw new UnsafeArgumentError(`argv[${index}] exceeds ${MAX_ARG_BYTES} bytes`, {
        details: { index, reason: 'element_too_long', bytes },
      });
    }
    total += bytes + 1;
  });
  if (total > MAX_ARGV_TOTAL_BYTES) {
    throw new UnsafeArgumentError(`argv exceeds ${MAX_ARGV_TOTAL_BYTES} bytes`, {
      details: { reason: 'total_too_long', bytes: total },
    });
  }
  if (opts.platform === 'win32') {
    let chars = 0;
    for (const arg of argv as readonly string[]) {
      chars += arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0);
    }
    if (chars > MAX_WIN32_COMMAND_LINE_CHARS) {
      throw new UnsafeArgumentError(
        `argv exceeds the ${MAX_WIN32_COMMAND_LINE_CHARS}-character Windows command line budget`,
        { details: { reason: 'win32_command_line_too_long', chars } },
      );
    }
  }
}

const REF_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Git branch/ref name: `/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}$/`, not ending in
 * '/', '.lock' or '.'. Additionally enforces git's component rules (no leading '/', no component
 * starting with '.' or ending in '.lock') so the name is always accepted by `git check-ref-format`.
 */
export function isSafeRefName(ref: string): boolean {
  if (typeof ref !== 'string' || !REF_NAME.test(ref)) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.lock') || ref.endsWith('.'))
    return false;
  return ref.split('/').every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

export function isCommitSha(ref: string): boolean {
  return typeof ref === 'string' && COMMIT_SHA.test(ref);
}

const TEST_EXECUTABLE = /^[A-Za-z0-9._/-]+$/;

/**
 * Project test command argv (spawned without a shell): 1..32 elements, each 1..1024 chars without
 * NUL; element[0] matches `/^[A-Za-z0-9._\/-]+$/`. Returns a frozen copy; throws `validation_failed`.
 */
export function validateTestCommand(argv: readonly string[]): readonly string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32) {
    throw validationFailed('testCommand', 'Test command must have 1..32 elements');
  }
  const copy: string[] = [];
  for (const element of argv as readonly unknown[]) {
    if (typeof element !== 'string' || element.length < 1 || element.length > 1024) {
      throw validationFailed(
        'testCommand',
        'Test command elements must be 1..1024 character strings',
      );
    }
    if (element.includes('\0')) {
      throw validationFailed('testCommand', 'Test command elements must not contain NUL bytes');
    }
    copy.push(element);
  }
  const executable = copy[0];
  if (executable === undefined || !TEST_EXECUTABLE.test(executable)) {
    throw validationFailed(
      'testCommand',
      'Test command executable must match /^[A-Za-z0-9._\\/-]+$/',
    );
  }
  return Object.freeze(copy);
}
