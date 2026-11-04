// T-m8: on Windows a windowless console process cannot be closed gracefully; stop() must not wait
// the full grace period before the forced kill.
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { spawnSupervised } from '@orc/shared/node';

const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
);

describe.runIf(process.platform === 'win32')('win32 stop of a windowless console process', () => {
  it('skips the grace wait when taskkill reports a forced kill is required', async () => {
    const child = spawnSupervised(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      cwd: tmpdir(),
      env,
    });
    const result = await child.stop({ graceMs: 20_000 });
    expect(result.survivors).toEqual([]);
    expect(result.forced).toBe(true);
    expect(result.durationMs).toBeLessThan(15_000);
    await child.exited;
  }, 40_000);
});
