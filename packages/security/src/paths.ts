import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { PathEscapeError, validationFailed } from './errors.js';

type PathEscapeReason =
  | 'invalid_root'
  | 'invalid_segment'
  | 'nul_byte'
  | 'absolute_segment'
  | 'outside_root'
  | 'symlink_escape';

const IS_WIN32 = process.platform === 'win32';
const hostPath = IS_WIN32 ? path.win32 : path.posix;

/** Drive-absolute (`C:\x`) and drive-relative (`C:x`) prefixes; both resolve outside the root on win32. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

function pathEscape(reason: PathEscapeReason, message: string): PathEscapeError {
  return new PathEscapeError(message, { details: { reason } });
}

function hasControlNul(value: string): boolean {
  return value.includes('\0');
}

/**
 * A segment is treated as absolute when it is absolute on EITHER platform, so a Windows-style
 * path (`C:\`, `\\server\share`, `\\?\`, `\foo`) is rejected on Linux and a POSIX one on Windows.
 */
function isAbsoluteOnAnyPlatform(segment: string): boolean {
  return (
    segment.startsWith('/') ||
    segment.startsWith('\\') ||
    DRIVE_PREFIX.test(segment) ||
    path.posix.isAbsolute(segment) ||
    path.win32.isAbsolute(segment)
  );
}

/** Case-insensitive on win32; requires a separator boundary so `/root-evil` is not inside `/root`. */
function isWithin(root: string, target: string): boolean {
  const r = IS_WIN32 ? root.toLowerCase() : root;
  const t = IS_WIN32 ? target.toLowerCase() : target;
  if (t === r) return true;
  const prefix = r.endsWith(hostPath.sep) ? r : r + hostPath.sep;
  return t.startsWith(prefix);
}

function normalizeRoot(root: string): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw pathEscape('invalid_root', 'Root directory must be a non-empty string');
  }
  if (hasControlNul(root)) throw pathEscape('nul_byte', 'Root directory contains a NUL byte');
  if (
    !hostPath.isAbsolute(root) ||
    (IS_WIN32 && !DRIVE_PREFIX.test(root) && !root.startsWith('\\\\'))
  ) {
    throw pathEscape('invalid_root', 'Root directory must be an absolute path');
  }
  return hostPath.resolve(root);
}

function checkSegment(segment: unknown, index: number): string {
  if (typeof segment !== 'string') {
    throw pathEscape('invalid_segment', `Path segment ${index} is not a string`);
  }
  if (hasControlNul(segment))
    throw pathEscape('nul_byte', `Path segment ${index} contains a NUL byte`);
  if (isAbsoluteOnAnyPlatform(segment)) {
    throw pathEscape('absolute_segment', `Path segment ${index} is absolute`);
  }
  if (IS_WIN32 && segment.includes(':')) {
    // Alternate data streams (`file:stream`) and drive designators are never valid in a segment.
    throw pathEscape('invalid_segment', `Path segment ${index} contains ':'`);
  }
  if (!IS_WIN32 && segment.includes('\\') && segment.split(/[\\/]/).includes('..')) {
    // `..\..\x` is a literal file name on POSIX but a traversal on Windows: reject it everywhere.
    throw pathEscape('invalid_segment', `Path segment ${index} contains a Windows-style traversal`);
  }
  return segment;
}

/**
 * `path.resolve(root, ...segments)` constrained to `root`. Rejects NUL bytes, absolute segments
 * (POSIX, drive, UNC and device forms on every platform) and lexical results outside the root
 * (case-insensitive on win32). Lexical only: use {@link realpathWithin} when symlinks matter.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const base = normalizeRoot(root);
  const checked = segments.map((s, i) => checkSegment(s, i));
  const result = hostPath.resolve(base, ...checked);
  if (!isWithin(base, result)) {
    throw pathEscape('outside_root', 'Resolved path escapes its root directory');
  }
  return result;
}

/**
 * {@link resolveWithin} followed by `fs.realpath` of both the root and the result, rejecting
 * symlink/junction escapes. The target must exist (fs errors such as ENOENT propagate unchanged).
 */
export async function realpathWithin(root: string, ...segments: string[]): Promise<string> {
  const lexical = resolveWithin(root, ...segments);
  const [realRoot, realTarget] = await Promise.all([
    realpath(normalizeRoot(root)),
    realpath(lexical),
  ]);
  if (!isWithin(realRoot, realTarget)) {
    throw pathEscape('symlink_escape', 'Resolved path escapes its root directory through a link');
  }
  return realTarget;
}

const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Windows reserved device names; refused on every platform so a project behaves the same everywhere. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Project repository path relative to PROJECTS_ROOT: 1..255 chars, '/'-separated segments matching
 * `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`, no '..', no leading '/'. Trailing '/' is dropped.
 * Returns the normalized `a/b` form; throws OrcError('validation_failed').
 */
export function normalizeRepoRelativePath(p: string): string {
  if (typeof p !== 'string' || p.length < 1 || p.length > 255) {
    throw validationFailed('repoPath', 'Repository path must be 1..255 characters');
  }
  if (p.startsWith('/')) throw validationFailed('repoPath', 'Repository path must be relative');
  if (p.includes('..')) throw validationFailed('repoPath', "Repository path must not contain '..'");
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!REPO_SEGMENT.test(segment)) {
      throw validationFailed(
        'repoPath',
        'Repository path segments must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
      );
    }
    if (segment.endsWith('.') || WINDOWS_RESERVED_NAME.test(segment)) {
      throw validationFailed('repoPath', 'Repository path segment is a reserved or ambiguous name');
    }
  }
  return segments.join('/');
}

/**
 * Worktree-relative file path (e.g. a JUnit report): <= 400 chars, no NUL or control characters,
 * not absolute (POSIX, drive or UNC), no '..' segment, no ':' (drive/stream designators).
 * Backslashes are treated as separators; '.' and empty segments are dropped. Returns `a/b/c`.
 */
export function normalizeWorktreeRelativePath(p: string): string {
  if (typeof p !== 'string' || p.length < 1 || p.length > 400) {
    throw validationFailed('path', 'Path must be 1..400 characters');
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\u0000-\u001f\u007f]/.test(p)) {
    throw validationFailed('path', 'Path must not contain control characters');
  }
  if (isAbsoluteOnAnyPlatform(p) || p.includes(':')) {
    throw validationFailed('path', 'Path must be relative to the worktree');
  }
  const segments = p.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segments.includes('..'))
    throw validationFailed('path', "Path must not contain '..' segments");
  if (segments.length === 0) throw validationFailed('path', 'Path must name a file');
  return segments.join('/');
}
