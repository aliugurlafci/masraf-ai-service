// B-020 (ADR-0036 m.4, contract §10.3): on win32 the per-workspace Claude HOME gets
// AppData\Roaming and AppData\Local (0700), exactly the APPDATA / LOCALAPPDATA values of the
// Claude env; POSIX creates nothing.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureClaudeAppDataDirs, type MkdirFn } from '@orc/orchestrator';
import { buildClaudeAppDataEnv } from '@orc/security';

const IS_WIN = process.platform === 'win32';
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function recordingMkdir(): MkdirFn & { calls: { dir: string; options: unknown }[] } {
  const calls: { dir: string; options: unknown }[] = [];
  const fn: MkdirFn = (dir, options) => {
    calls.push({ dir, options });
    return Promise.resolve(undefined);
  };
  return Object.assign(fn, { calls });
}

describe('ensureClaudeAppDataDirs', () => {
  it('win32: Roaming and Local below HOME, recursive, mode 0700, equal to the env values', async () => {
    const home = 'C:\\orc\\claude-home\\w\\9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d\\home';
    const mk = recordingMkdir();
    const dirs = await ensureClaudeAppDataDirs(home, 'win32', mk);
    expect(dirs).toEqual([win32.join(home, 'AppData', 'Roaming'), win32.join(home, 'AppData', 'Local')]);
    expect(mk.calls).toEqual(dirs.map((dir) => ({ dir, options: { recursive: true, mode: 0o700 } })));
    const env = buildClaudeAppDataEnv('claude', home, 'win32');
    expect(new Set(dirs)).toEqual(new Set([env['APPDATA'], env['LOCALAPPDATA']]));
  });

  it('POSIX: nothing to create', async () => {
    const mk = recordingMkdir();
    expect(await ensureClaudeAppDataDirs('/var/lib/orc/claude-home/w/x/home', 'posix', mk)).toEqual([]);
    expect(mk.calls).toEqual([]);
  });

  it('rejects an invalid home without creating anything', async () => {
    const mk = recordingMkdir();
    await expect(ensureClaudeAppDataDirs('', 'win32', mk)).rejects.toMatchObject({ code: 'unsafe_argument' });
    await expect(ensureClaudeAppDataDirs('C:\\a\0b', 'win32', mk)).rejects.toMatchObject({
      code: 'unsafe_argument',
    });
    expect(mk.calls).toEqual([]);
  });

  it('real filesystem on this host: idempotent; AppData only on win32', async () => {
    // A prefix already registered in tests/setup/leak-ledger.ts (K6 leak guard).
    const base = mkdtempSync(join(tmpdir(), 'orc-claude-runner-'));
    temps.push(base);
    const home = join(base, 'home');
    const platform = IS_WIN ? 'win32' : 'posix';
    const first = await ensureClaudeAppDataDirs(home, platform);
    const second = await ensureClaudeAppDataDirs(home, platform);
    expect(second).toEqual(first);
    if (IS_WIN) {
      expect(first).toHaveLength(2);
      for (const d of first) expect(statSync(d).isDirectory()).toBe(true);
    } else {
      expect(first).toEqual([]);
      expect(existsSync(join(home, 'AppData'))).toBe(false);
    }
  });
});
