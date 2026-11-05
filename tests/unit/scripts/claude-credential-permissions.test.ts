import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../../helpers/common';

interface Stat {
  mode: number;
  uid: number;
  gid?: number;
  size: number;
}
interface Lib {
  credentialPermissionWarnings: (name: string, stat: Stat, platform?: string) => string[];
}
const load = async (): Promise<Lib> =>
  (await import(pathToFileURL(join(__dirname, '..', '..', '..', 'scripts/lib/claude-credentials.mjs')).href)) as Lib;
const FAKE_TOKEN = `sk-ant-oat01-${'A'.repeat(40)}`;

describe('credentialPermissionWarnings (pure)', () => {
  it('warns for world-readable non-empty files, not for 0600/0400 owned by the worker uid', async () => {
    const { credentialPermissionWarnings: w } = await load();
    expect(w('claude_oauth_token', { mode: 0o100644, uid: 1000, size: 60 }, 'linux')).toHaveLength(1);
    expect(w('claude_oauth_token', { mode: 0o100600, uid: 1000, size: 60 }, 'linux')).toEqual([]);
    expect(w('anthropic_api_key', { mode: 0o100400, uid: 1000, size: 60 }, 'linux')).toEqual([]);
  });

  it('warns when another uid owns an unreadable-for-group file; skips empty files and win32', async () => {
    const { credentialPermissionWarnings: w } = await load();
    expect(w('claude_oauth_token', { mode: 0o100600, uid: 501, size: 60 }, 'linux').join()).toMatch(/uid 1000/);
    expect(w('claude_oauth_token', { mode: 0o100644, uid: 501, size: 0 }, 'linux')).toEqual([]);
    expect(w('claude_oauth_token', { mode: 0o100666, uid: 501, size: 60 }, 'win32')).toEqual([]);
  });

  it('can-uid-1000-read rule: root 0600 and foreign gid 0640 warn; 1000:1000 0600 and gid 1000 0640 do not', async () => {
    const { credentialPermissionWarnings: w } = await load();
    expect(w('claude_oauth_token', { mode: 0o100600, uid: 0, gid: 0, size: 60 }, 'linux').join()).toMatch(/uid 1000/);
    expect(w('claude_oauth_token', { mode: 0o100640, uid: 0, gid: 501, size: 60 }, 'linux')).toHaveLength(1);
    expect(w('claude_oauth_token', { mode: 0o100600, uid: 1000, gid: 1000, size: 60 }, 'linux')).toEqual([]);
    expect(w('claude_oauth_token', { mode: 0o100640, uid: 0, gid: 1000, size: 60 }, 'linux')).toEqual([]);
    expect(w('claude_oauth_token', { mode: 0o100200, uid: 1000, gid: 1000, size: 60 }, 'linux')).toHaveLength(1);
  });

  it('never includes the file content', async () => {
    const { credentialPermissionWarnings: w } = await load();
    expect(w('claude_oauth_token', { mode: 0o100644, uid: 1000, size: 60 }, 'linux').join()).not.toContain('sk-ant');
  });
});

describe.skipIf(process.platform === 'win32')('credentialPermissionWarnings (real files)', () => {
  const tmp = useTempDir();
  it('0644 warns, 0600 does not (file owned by the current user)', async () => {
    const { credentialPermissionWarnings: w } = await load();
    const file = join(tmp(), 'claude_oauth_token.txt');
    writeFileSync(file, FAKE_TOKEN);
    chmodSync(file, 0o644);
    expect(w('claude_oauth_token', statSync(file))).toHaveLength(1);
    chmodSync(file, 0o600);
    const stat = statSync(file);
    // Mode 0600: readable by the worker only when the file is owned by uid 1000 (root-owned does not count).
    const expected = stat.uid === 1000 ? 0 : 1;
    expect(w('claude_oauth_token', stat)).toHaveLength(expected);
  });
});
