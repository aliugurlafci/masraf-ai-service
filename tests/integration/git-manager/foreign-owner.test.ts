// Regression D1-WP8 (ADR-0033): the source repository belongs to another uid than the process running
// git (Docker Desktop bind mounts look root-owned to the uid-1000 worker; Linux hosts may use any uid).
// git 2.39.4+ (CVE-2024-32004 fix, Debian bookworm 2.39.5) makes upload-pack refuse such a repository
// unless safe.directory names its git dir, and the local transport starts upload-pack with git's
// local_repo_env cleared, i.e. without the `-c safe.directory=` of the fetch. mirror_fetch therefore
// passes the trust through a per-call GIT_CONFIG_GLOBAL file.
// Runs on Linux as root (`npm run test:linux`): the fixture is chowned to FOREIGN_UID, so owner and
// process uid differ exactly like root-owned mount vs. uid 1000 in the stack (git does not exempt root).
import { existsSync, lchownSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitOpContext } from '@orc/git-manager';
import { writeFileP } from '../../helpers/git/fixtures';
import { createWorld, type World } from '../../helpers/git/world';

const CAN_CHOWN = process.platform === 'linux' && process.getuid?.() === 0;
const FOREIGN_UID = 4242;
const PROJECT_2 = '6f2a1b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c';

function chownTree(p: string, uid: number): void {
  const st = lstatSync(p);
  lchownSync(p, uid, uid);
  if (st.isDirectory()) for (const name of readdirSync(p)) chownTree(path.join(p, name), uid);
}

describe.skipIf(!CAN_CHOWN)(
  'git-manager: source repository owned by another uid (Linux, root)',
  () => {
    let w: World;

    beforeEach(() => {
      w = createWorld();
    });

    afterEach(() => {
      w.dispose();
    });

    it('precondition: upload-pack without safe.directory refuses the fixture (dubious ownership)', () => {
      const { dir } = w.repo('acme/app', { 'README.md': 'v1\n' });
      chownTree(dir, FOREIGN_UID);
      expect(lstatSync(path.join(dir, '.git')).uid).not.toBe(process.getuid?.());
      const r = w.git(w.root, ['upload-pack', '--advertise-refs', path.join(dir, '.git')], true);
      expect(r.status).toBe(128);
      expect(r.stderr).toContain('detected dubious ownership');
    });

    it('syncMirror creates the mirror and fetches new commits; the transport config is removed', async () => {
      const { dir, sha } = w.repo('acme/app', { 'README.md': 'v1\n' });
      chownTree(dir, FOREIGN_UID);
      const gm = w.manager();

      const first = await gm.syncMirror(w.projectId, 'acme/app', w.ctx);
      expect(first.branches).toEqual([{ name: 'main', sha }]);

      // A new commit on the source side (owner flipped only for the fixture git), then an incremental fetch.
      chownTree(dir, 0);
      writeFileP(path.join(dir, 'README.md'), 'v2\n');
      w.git(dir, ['commit', '--quiet', '--all', '-m', 'second']);
      const sha2 = w.git(dir, ['rev-parse', 'HEAD']).stdout.trim();
      chownTree(dir, FOREIGN_UID);
      const second = await gm.syncMirror(w.projectId, 'acme/app', w.ctx);
      expect(second.branches).toEqual([{ name: 'main', sha: sha2 }]);

      const fetches = w.recorder.ops.filter((o) => o.operation === 'mirror_fetch');
      expect(fetches.map((o) => o.success)).toEqual([true, true]);
      const configDir = path.join(w.ws, '.orc', 'git-config', 'it-worker');
      expect(existsSync(configDir) ? readdirSync(configDir) : []).toEqual([]);
    });

    it('bare source repository owned by another uid', async () => {
      const { dir, sha } = w.repo('acme/app', { 'a.txt': 'a\n' });
      const bare = path.join(w.pr, 'acme', 'bare.git');
      w.git(w.root, ['clone', '--quiet', '--bare', dir, bare]);
      chownTree(bare, FOREIGN_UID);
      const ctx: GitOpContext = { ...w.ctx, projectId: PROJECT_2 };
      const info = await w.manager().syncMirror(PROJECT_2, 'acme/bare.git', ctx);
      expect(info.branches).toEqual([{ name: 'main', sha }]);
    });
  },
);
