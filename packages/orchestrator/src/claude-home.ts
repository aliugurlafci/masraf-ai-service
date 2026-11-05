// Per-workspace Claude home (contract §10.3): B-020 isolated AppData on win32 (ADR-0036 m.4).
import { mkdir } from 'node:fs/promises';
import { buildClaudeAppDataEnv } from '@orc/security';
import type { HostPlatform } from '@orc/shared/node';

export type MkdirFn = (dir: string, options: { recursive: true; mode: number }) => Promise<unknown>;

/**
 * win32: creates `<homeDir>\AppData\Roaming` and `<homeDir>\AppData\Local` (mode 0700), the very
 * paths the Claude env gets as `APPDATA` / `LOCALAPPDATA` (`buildClaudeAppDataEnv`). `homeDir` is
 * the per-workspace `HOME` (already anchored with `resolveWithin`). POSIX: nothing to create.
 * Returns the directories in creation order.
 */
export async function ensureClaudeAppDataDirs(
  homeDir: string,
  platform: HostPlatform,
  mkdirFn: MkdirFn = mkdir,
): Promise<string[]> {
  const dirs = Object.values(buildClaudeAppDataEnv('claude', homeDir, platform));
  for (const dir of dirs) await mkdirFn(dir, { recursive: true, mode: 0o700 });
  return dirs;
}
