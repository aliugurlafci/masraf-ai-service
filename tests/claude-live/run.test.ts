// claude-live (opt-in, CLAUDE_LIVE=1): one tiny REAL run in production mode (`--bare` + ANTHROPIC_API_KEY,
// contract §10.2/§10.3) with the cheapest model alias: the CLI edits a file inside the worktree with the scoped
// allow rules, ends with a success result inside the budget and leaves no process behind. Skipped (with the reason
// in the test name) when no API key is available, because a non-bare run in the isolated config dir is not logged in.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingHandlers } from '../helpers/claude/fake-claude';
import { HAS_API_KEY, LIVE_API_KEY, createLiveEnv } from './live-env';
import type { LiveEnv } from './live-env';

let env: LiveEnv | null = null;

afterEach(async () => {
  const current = env;
  env = null;
  if (current) expect((await current.close()).alive, 'claude processes alive after the test').toEqual([]);
});

describe('claude-live: tiny real run', () => {
  it.skipIf(!HAS_API_KEY)('bare run with ANTHROPIC_API_KEY edits a worktree file and succeeds (skipped without a key)', async () => {
    env = await createLiveEnv();
    expect(env.bare).toBe(true);
    const { handlers, rec } = recordingHandlers();
    const result = await env.runner.run(
      env.request({
        prompt: [
          'Use the Write tool to create the file live.txt in the current working directory with exactly the content: orc-live-ok',
          'Then reply with the single word DONE.',
        ].join('\n'),
        maxBudgetUsd: 0.25,
        deadlineMs: 240_000,
      }),
      handlers,
    );
    expect(result.violation).toBeNull();
    expect(result.outcome).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(rec.inits[0]?.validation.ok).toBe(true);
    expect(readFileSync(path.join(env.layout.worktree, 'live.txt'), 'utf8').trim()).toBe('orc-live-ok');
    expect(result.result?.permission_denials ?? []).toEqual([]);
    expect(result.result?.total_cost_usd ?? 0).toBeGreaterThan(0);
    // the key never appears in what the runner hands to the log sink (masked, §15.6)
    const transcript = rec.lines.map((l) => l.raw).join('\n') + rec.stderr.join('');
    if (LIVE_API_KEY !== null) expect(transcript).not.toContain(LIVE_API_KEY);
  });
});
