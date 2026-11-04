import { isOrcError } from '@orc/shared';

const SPAWN_ERRNO = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'ENOTDIR', 'EISDIR']);

/** True when the executable could not be started (missing, not executable): outcome `spawn_failed`. */
export function isSpawnFailure(e: unknown): boolean {
  if (isOrcError(e)) return e.code === 'process_spawn_failed';
  if (e instanceof Error && 'code' in e && typeof e.code === 'string') return SPAWN_ERRNO.has(e.code);
  return false;
}
