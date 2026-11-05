// claude-live (opt-in, CLAUDE_LIVE=1) credential-leak check (ADR-0036 Decision 11, Opus K8): with the REAL CLI and a
// real credential, neither the MCP child nor a `node --test` Bash child of the agent may see the OAuth token or its
// fd 3, and no file below the run's temp tree (worktree, per-workspace HOME/config, caches) may contain the token.
// api_key mode (CLAUDE_LIVE_AUTH_MODE=api_key): the MCP child sees an EMPTY key (the mcp.json `env` override of
// D-3); the Bash child is a documented residual risk and is not asserted there.
// The credential comes only from the environment (see live-env.ts) and is never printed: reports hold names,
// lengths and booleans; file matches are reported by relative path only. POSIX only (fd 3 does not exist on win32,
// where the token travels in the env by design and only dev use is supported).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingHandlers } from '../helpers/claude/fake-claude';
import { HAS_CREDENTIAL, LIVE_AUTH_MODE, LIVE_CREDENTIAL, createLiveEnv } from './live-env';
import type { LiveEnv } from './live-env';

const LEAK_PROBE_MCP = path.resolve(import.meta.dirname, 'leak-probe-mcp.mjs');
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

/** Written into the worktree; node:test runs it as a Bash child of the agent. It reports names and booleans only. */
const BASH_CHILD_TEST = `import { test } from 'node:test';
import { fstatSync, readFileSync, readSync, readlinkSync, writeFileSync } from 'node:fs';

test('credential visibility of a Bash child', () => {
  const env = process.env;
  let fd3 = { open: false, link: null, holdsCredential: false };
  try {
    fstatSync(3);
    let link = 'unknown';
    try { link = readlinkSync('/proc/self/fd/3'); } catch {}
    let holds = false;
    if (link.startsWith('pipe:') || link.startsWith('/')) {
      try {
        const buf = Buffer.alloc(4096);
        const n = readSync(3, buf, 0, buf.length, null);
        holds = n > 0 && /sk-ant-/.test(buf.subarray(0, n).toString('utf8'));
      } catch {}
    }
    fd3 = { open: true, link, holdsCredential: holds };
  } catch {}
  writeFileSync('leak-bash.json', JSON.stringify({
    credentialVarNames: Object.keys(env).filter((n) => /^CLAUDE_CODE_OAUTH_TOKEN/.test(n)),
    apiKeyPresent: Object.hasOwn(env, 'ANTHROPIC_API_KEY'),
    valuesWithTokenShape: Object.entries(env).filter(([, v]) => /sk-ant-oat/.test(String(v))).map(([k]) => k),
    fd3,
  }));
});
`;

interface LeakReport {
  credentialVarNames: string[];
  apiKeyPresent: boolean;
  apiKeyLength?: number;
  valuesWithTokenShape: string[];
  fd3: { open: boolean; link: string | null; holdsCredential: boolean };
}

function readReport(file: string): LeakReport {
  return JSON.parse(readFileSync(file, 'utf8')) as LeakReport;
}

/** Relative paths of files below `root` that contain any needle (never returns the content). */
function scanTree(root: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (st === undefined) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size <= MAX_SCAN_BYTES) {
        const data = readFileSync(full);
        if (needles.some((n) => data.includes(n))) hits.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return hits;
}

let env: LiveEnv | null = null;
let root: string | null = null;

afterEach(async () => {
  const current = env;
  env = null;
  root = null;
  if (current) expect((await current.close()).alive, 'claude processes alive after the test').toEqual([]);
});

describe.skipIf(process.platform === 'win32')('claude-live: credential leak (ADR-0036)', () => {
  it.skipIf(!HAS_CREDENTIAL)(
    'MCP child and a node --test Bash child see no token and no credential fd; nothing on disk (skipped without a credential)',
    async () => {
      env = await createLiveEnv();
      root = env.dir.path;
      const { layout } = env;
      const mcpReportPath = path.join(layout.metaDir, 'leak-mcp.json');
      await mkdir(layout.metaDir, { recursive: true });
      await env.writeMcpConfig({ script: LEAK_PROBE_MCP, env: { LEAK_REPORT: mcpReportPath } });
      await writeFile(path.join(layout.worktree, 'leak.test.mjs'), BASH_CHILD_TEST);

      const { handlers, rec } = recordingHandlers();
      const result = await env.runner.run(
        env.request({
          prompt: [
            'Run exactly this command with the Bash tool: node --test leak.test.mjs',
            'Then reply with the single word DONE and do nothing else.',
          ].join('\n'),
          mcp: true,
          agentAllowedTools: ['Read', 'Glob', 'Grep', 'Bash(node --test:*)'],
          maxBudgetUsd: 0.25,
          deadlineMs: 240_000,
        }),
        handlers,
      );
      expect(result.violation).toBeNull();
      expect(result.outcome).toBe('success');
      expect(rec.inits[0]?.validation.ok).toBe(true);
      expect(rec.inits[0]?.validation.mcpConnected).toBe(true);

      // MCP child
      expect(existsSync(mcpReportPath), 'the MCP child wrote its report').toBe(true);
      const mcp = readReport(mcpReportPath);
      expect(mcp.credentialVarNames).toEqual([]);
      expect(mcp.valuesWithTokenShape).toEqual([]);
      expect(mcp.fd3.holdsCredential).toBe(false);
      if (LIVE_AUTH_MODE === 'api_key') {
        // D-3: the mcp.json env override leaves an empty value
        expect(mcp.apiKeyLength).toBe(0);
      } else {
        expect(mcp.apiKeyPresent).toBe(false);
      }

      // Bash child (oauth only; in api_key mode the key reaching Bash is a documented residual risk)
      if (LIVE_AUTH_MODE === 'oauth') {
        const bashReportPath = path.join(layout.worktree, 'leak-bash.json');
        expect(existsSync(bashReportPath), 'the Bash child ran node --test and wrote its report').toBe(true);
        const bash = readReport(bashReportPath);
        expect(bash.credentialVarNames).toEqual([]);
        expect(bash.valuesWithTokenShape).toEqual([]);
        expect(bash.apiKeyPresent).toBe(false);
        expect(bash.fd3.holdsCredential).toBe(false);
        // fd 3 must not be an inherited pipe or file (an anonymous inode such as an event loop is not a credential fd)
        expect(bash.fd3.link === null || bash.fd3.link.startsWith('anon_inode:')).toBe(true);
      }

      // transcript and disk: the value is nowhere
      const credential = LIVE_CREDENTIAL ?? '';
      const needles = [credential, Buffer.from(credential).toString('base64')];
      const transcript = rec.lines.map((l) => l.raw).join('\n') + rec.stderr.join('');
      expect(needles.some((n) => transcript.includes(n))).toBe(false);
      expect(scanTree(root, needles)).toEqual([]);
    },
    300_000,
  );
});
