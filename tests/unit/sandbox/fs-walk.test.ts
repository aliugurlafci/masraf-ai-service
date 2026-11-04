import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chownTree, handoffMode, measureTree, reclaimMode } from '@orc/sandbox';
import { recordingFs } from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

describe('modes', () => {
  it('handoff = u+rwX,go-rwx without special bits', () => {
    expect(handoffMode(0o644, false)).toBe(0o600);
    expect(handoffMode(0o755, false)).toBe(0o700);
    expect(handoffMode(0o000, false)).toBe(0o600);
    expect(handoffMode(0o010, false)).toBe(0o700);
    expect(handoffMode(0o755, true)).toBe(0o700);
    expect(handoffMode(0o000, true)).toBe(0o700);
    expect(handoffMode(0o4755, false)).toBe(0o700);
    expect(handoffMode(0o2777, true)).toBe(0o700);
    expect(handoffMode(0o1777, true)).toBe(0o700);
  });
  it('reclaim makes trees private to the worker again', () => {
    expect(reclaimMode(0o777, false)).toBe(0o700);
    expect(reclaimMode(0o666, false)).toBe(0o600);
    expect(reclaimMode(0o4711, false)).toBe(0o700);
    expect(reclaimMode(0o000, true)).toBe(0o700);
  });
});

describe('ownership walk', () => {
  let r: SandboxRoots;
  let wt: string;
  let target: string;
  beforeAll(() => {
    r = makeRoots();
    wt = r.attemptPaths('t1').worktree;
    target = join(r.base, 'outside');
    mkdirSync(join(target, 'deep'), { recursive: true });
    writeFileSync(join(target, 'deep', 'secret.txt'), 'secret');
    symlinkSync(target, join(wt, 'link-dir'), 'junction');
  });
  afterAll(() => r.cleanup());

  it('lchowns every entry, never chmods or enters a symlink', async () => {
    const fs = recordingFs();
    const res = await chownTree(wt, { uid: 20001, gid: 20001, mode: handoffMode, apply: true }, fs);
    const chowned = fs.calls.filter((c) => c.op === 'lchown').map((c) => c.path);
    const chmodded = fs.calls.filter((c) => c.op === 'chmod').map((c) => c.path);
    expect(chowned).toEqual(
      expect.arrayContaining([
        wt,
        join(wt, 'src'),
        join(wt, 'src', 'index.ts'),
        join(wt, 'README.md'),
        join(wt, '.git'),
        join(wt, 'link-dir'),
      ]),
    );
    expect(chowned).toHaveLength(6);
    expect(res.entries).toBe(6);
    expect(chmodded).not.toContain(join(wt, 'link-dir'));
    expect(chowned.some((p) => p.startsWith(target))).toBe(false);
    expect(fs.calls.every((c) => c.op !== 'lchown' || (c.uid === 20001 && c.gid === 20001))).toBe(
      true,
    );
    const rootChmod = fs.calls.find((c) => c.op === 'chmod' && c.path === wt);
    expect(rootChmod?.mode).toBe(0o700);
  });

  it('apply=false only walks', async () => {
    const fs = recordingFs();
    const res = await chownTree(wt, { uid: 1, gid: 1, mode: reclaimMode, apply: false }, fs);
    expect(res.entries).toBe(6);
    expect(fs.calls).toEqual([]);
  });

  it('a missing root is a no-op', async () => {
    const fs = recordingFs();
    expect(
      await chownTree(join(wt, 'missing'), { uid: 1, gid: 1, mode: reclaimMode, apply: true }, fs),
    ).toEqual({ entries: 0 });
  });

  it('measure counts bytes without following links and skips .git files', async () => {
    const m = await measureTree(wt, 1000);
    expect(m.truncated).toBe(false);
    // wt, src, src/index.ts, README.md, link-dir (the .git file is skipped)
    expect(m.entries).toBe(5);
    expect(m.bytes).toBeGreaterThanOrEqual('export const x = 1;\n'.length + '# test\n'.length);
    const t = await measureTree(wt, 2);
    expect(t).toMatchObject({ truncated: true, entries: 2 });
  });
});
