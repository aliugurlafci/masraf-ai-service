// createClaudeRunner (contract §2.8).
import { z } from 'zod';
import { OrcError, systemClock } from '@orc/shared';
import { buildClaudeArgv } from './argv';
import { buildClaudeEnv, proxyUrlWithToken } from './env';
import { probeClaude } from './probe';
import { runClaude } from './run';
import type {
  ClaudeRunHandlers,
  ClaudeRunner,
  ClaudeRunnerConfig,
  ClaudeRunnerDeps,
  ClaudeRunRequest,
  ClaudeRunResult,
} from './types';

const nonEmpty = z.string().min(1).refine((s) => !s.includes('\0'), 'NUL');
const nullableText = nonEmpty.nullable();
/** Tool names an operator may admit via CLAUDE_INIT_EXTRA_TOOLS (§10.6, §16.3). */
const FORBIDDEN_EXTRA_TOOLS = new Set(['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit']);

const ClaudeRunnerConfigSchema = z.object({
  bin: nonEmpty,
  binPrefixArgs: z.array(nonEmpty),
  bare: z.boolean(),
  claudeHomeRoot: nonEmpty,
  apiKey: nullableText,
  proxy: z.object({ https: nullableText, http: nullableText, noProxy: nullableText, token: nullableText }),
  killGraceMs: z.number().int().min(0),
  initTimeoutMs: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxLineBytes: z.number().int().positive(),
  cbmCacheRoot: nonEmpty,
  platform: z.enum(['posix', 'win32']),
  workerId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  initExtraTools: z.array(
    z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)
      .refine((t) => !FORBIDDEN_EXTRA_TOOLS.has(t) && !t.startsWith('mcp__'), 'tool not admissible'),
  ),
});

function assertConfig(cfg: ClaudeRunnerConfig): void {
  const parsed = ClaudeRunnerConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    // Paths and keys only; never values (the config carries the API key).
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.')))];
    throw new OrcError('config_invalid', `Invalid Claude runner configuration: ${keys.join(', ')}`, {
      details: { keys },
    });
  }
  if (cfg.bare && cfg.apiKey === null) {
    throw new OrcError('config_invalid', 'ANTHROPIC_API_KEY is required when CLAUDE_BARE=true', {
      details: { keys: ['apiKey'] },
    });
  }
}

export function createClaudeRunner(cfg: ClaudeRunnerConfig, deps: ClaudeRunnerDeps): ClaudeRunner {
  assertConfig(cfg);
  const clock = deps.clock ?? systemClock;
  const source = deps.env ?? process.env;
  // Every credential handed to Claude is masked in its output and in our logs.
  deps.secrets.add(cfg.apiKey);
  deps.secrets.add(cfg.proxy.token);
  if (cfg.proxy.https !== null && cfg.proxy.token !== null && cfg.proxy.token.length > 0) {
    deps.secrets.add(proxyUrlWithToken(cfg.proxy.https, cfg.proxy.token));
  }

  const buildArgv = (r: ClaudeRunRequest): string[] =>
    buildClaudeArgv(r, { bare: cfg.bare, platform: cfg.platform });
  const buildEnv = (r: ClaudeRunRequest): Record<string, string> => buildClaudeEnv(cfg, r, source);

  return {
    probe: () => probeClaude(cfg, { logger: deps.logger, launcher: deps.launcher, env: source }),
    buildArgv,
    buildEnv,
    async run(r: ClaudeRunRequest, h: ClaudeRunHandlers): Promise<ClaudeRunResult> {
      const argv = buildArgv(r);
      const env = buildEnv(r);
      return runClaude(
        {
          cfg,
          logger: deps.logger,
          secrets: deps.secrets,
          launcher: deps.launcher,
          clock,
          argv,
          env,
        },
        r,
        h,
      );
    },
  };
}
