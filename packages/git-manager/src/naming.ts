// Branch / worktree naming, input validation and argv sanitizing (contract §11.2, §11.7).
import { GUID_REGEX, ValidationError, shortKey, type Uuid } from '@orc/shared';
import { isCommitSha, isSafeRefName } from '@orc/security';

export const MAX_ATTEMPT_NUMBER = 1_000_000;
export const BRANCH_PREFIX = 'orc/task-';
export const KEY_LENGTHS = [8, 12, 32] as const;

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Deletable paths relative to WORKSPACES_ROOT (§11.7). */
export const ATTEMPT_REL_PATH = new RegExp(`^(${GUID})/(${GUID})/a(\\d{1,7})$`);
export const ATTEMPT_META_REL_PATH = new RegExp(`^(${GUID})/(${GUID})/a(\\d{1,7})\\.meta$`);
export const BASE_REL_PATH = new RegExp(`^(${GUID})/_base$`);

const ARG_MAX_CHARS = 512;

export function invalid(path: string, message: string): ValidationError {
  return new ValidationError([{ path, message, code: 'invalid' }], message);
}

export function assertGuid(value: unknown, name: string): asserts value is Uuid {
  if (typeof value !== 'string' || !GUID_REGEX.test(value)) {
    throw invalid(name, `${name} must be a lower-case GUID`);
  }
}

export function assertAttemptNumber(n: unknown): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_ATTEMPT_NUMBER) {
    throw invalid('attemptNumber', `attemptNumber must be an integer 1..${MAX_ATTEMPT_NUMBER}`);
  }
}

export function assertSha(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !isCommitSha(value)) {
    throw invalid(name, `${name} must be a hexadecimal commit id`);
  }
}

export function assertBranchName(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !isSafeRefName(value)) {
    throw invalid(name, `${name} is not a safe branch name`);
  }
}

/** `orc/task-${shortKey(taskId, keyLength)}-a${attemptNumber}` (§11.2). */
export function branchNameFor(taskId: Uuid, attemptNumber: number, keyLength: 8 | 12 | 32): string {
  assertGuid(taskId, 'taskId');
  assertAttemptNumber(attemptNumber);
  if (!KEY_LENGTHS.includes(keyLength)) throw invalid('keyLength', 'keyLength must be 8, 12 or 32');
  return `${BRANCH_PREFIX}${shortKey(taskId, keyLength)}-a${attemptNumber}`;
}

/** `${projectId}/${taskId}/a${n}` relative to WORKSPACES_ROOT ('/'-separated). */
export function worktreeRelPath(projectId: Uuid, taskId: Uuid, attemptNumber: number): string {
  assertGuid(projectId, 'projectId');
  assertGuid(taskId, 'taskId');
  assertAttemptNumber(attemptNumber);
  return `${projectId}/${taskId}/a${attemptNumber}`;
}

export type WorkspaceRelKind = 'attempt' | 'base';

/** Validates a worktree path relative to WORKSPACES_ROOT and that it belongs to `projectId`. */
export function parseWorktreeRelPath(
  relPath: unknown,
  projectId: Uuid,
  allowed: readonly WorkspaceRelKind[] = ['attempt', 'base'],
): { kind: WorkspaceRelKind; segments: string[] } {
  if (typeof relPath !== 'string') throw invalid('relPath', 'relPath must be a string');
  const attempt = ATTEMPT_REL_PATH.exec(relPath);
  if (attempt && allowed.includes('attempt')) {
    if (attempt[1] !== projectId) throw invalid('relPath', 'relPath belongs to another project');
    return { kind: 'attempt', segments: relPath.split('/') };
  }
  const base = BASE_REL_PATH.exec(relPath);
  if (base && allowed.includes('base')) {
    if (base[1] !== projectId) throw invalid('relPath', 'relPath belongs to another project');
    return { kind: 'base', segments: relPath.split('/') };
  }
  throw invalid('relPath', 'relPath is not a managed worktree path');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksWindows(root: string): boolean {
  return /^[A-Za-z]:/.test(root) || root.startsWith('\\\\') || root.includes('\\');
}

function stripTrailingSeparators(root: string): string {
  let r = root;
  while (r.length > 1 && (r.endsWith('/') || r.endsWith('\\')) && !/^[A-Za-z]:[\\/]$/.test(r)) {
    r = r.slice(0, -1);
  }
  return r;
}

function truncateArg(s: string): string {
  if (s.length <= ARG_MAX_CHARS) return s;
  let end = ARG_MAX_CHARS;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * §11.7: absolute WORKSPACES_ROOT / PROJECTS_ROOT prefixes (native and '/'-separated spellings,
 * case-insensitive for Windows paths) replaced by `<WORKSPACES_ROOT>` / `<PROJECTS_ROOT>`;
 * each argument truncated to 512 chars.
 */
export function sanitizeGitArgs(
  args: readonly string[],
  roots: { projectsRoot: string; workspacesRoot: string },
): string[] {
  const variants: { text: string; token: string; ci: boolean }[] = [];
  const addRoot = (root: string, token: string): void => {
    if (typeof root !== 'string' || root.length === 0) return;
    const base = stripTrailingSeparators(root);
    if (base === '/' || base.length === 0) return;
    const ci = looksWindows(base);
    for (const text of new Set([base, base.replaceAll('\\', '/'), base.replaceAll('/', '\\')])) {
      variants.push({ text, token, ci });
    }
  };
  addRoot(roots.workspacesRoot, '<WORKSPACES_ROOT>');
  addRoot(roots.projectsRoot, '<PROJECTS_ROOT>');
  variants.sort((a, b) => b.text.length - a.text.length);
  const patterns = variants.map((v) => ({
    re: new RegExp(`${escapeRegExp(v.text)}(?=$|[\\\\/])`, v.ci ? 'gi' : 'g'),
    token: v.token,
  }));
  return args.map((arg) => {
    let out = String(arg);
    for (const p of patterns) out = out.replace(p.re, p.token);
    return truncateArg(out);
  });
}
