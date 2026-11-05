// createClaudeRunner (contract §2.8).
import { z } from 'zod';
import { OrcError, systemClock } from '@orc/shared';
import { serializeError } from '@orc/logger';
import { CLAUDE_OAUTH_TOKEN_REGEX } from '@orc/shared/node';
import { buildClaudeArgv } from './argv';
import { buildClaudeEnv, buildClaudeLaunchEnv, proxyUrlWithToken } from './env';
import { ClaudeProbeError } from './errors';
import { probeClaude } from './probe';
import { emptyResult, runClaude } from './run';
import type {
  ClaudeProbeResult,
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
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/** ADR-0036 Decision 1: exactly one credential, matching its mode (a second field is rejected). */
const ClaudeAuthSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('oauth'),
    oauthToken: nonEmpty.regex(CLAUDE_OAUTH_TOKEN_REGEX),
  }),
  z.strictObject({
    mode: z.literal('api_key'),
    apiKey: nonEmpty.refine((k) => !k.startsWith(OAUTH_TOKEN_PREFIX), 'OAuth token in api_key mode'),
  }),
]);

const extensionNames = z.array(nonEmpty).readonly();
const ReviewedExtensionTableSchema = z.record(
  z.string().regex(/^\d+\.\d+\.\d+\/(posix|win32)\/(oauth|api_key)$/),
  z.strictObject({
    skills: extensionNames,
    agents: extensionNames,
    slashCommands: extensionNames,
    plugins: extensionNames,
  }),
);

const ClaudeRunnerConfigSchema = z.object({
  bin: nonEmpty,
  binPrefixArgs: z.array(nonEmpty),
  claudeHomeRoot: nonEmpty,
  auth: ClaudeAuthSchema,
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
  reviewedExtensions: ReviewedExtensionTableSchema.optional(),
});

function assertConfig(cfg: ClaudeRunnerConfig): void {
  const parsed = ClaudeRunnerConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    // Paths and keys only; never values (the config carries the credential).
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.')))];
    throw new OrcError('config_invalid', `Invalid Claude runner configuration: ${keys.join(', ')}`, {
      details: { keys },
    });
  }
}

/** Every form a credential may take in output or logs: raw, and the base64 of the fd 3 payload. */
function credentialVariants(cfg: ClaudeRunnerConfig): string[] {
  const value = cfg.auth.mode === 'oauth' ? cfg.auth.oauthToken : cfg.auth.apiKey;
  return [value, Buffer.from(value, 'utf8').toString('base64')];
}

export function createClaudeRunner(cfg: ClaudeRunnerConfig, deps: ClaudeRunnerDeps): ClaudeRunner {
  assertConfig(cfg);
  const clock = deps.clock ?? systemClock;
  const source = deps.env ?? process.env;
  // Every credential handed to Claude is masked in its output and in our logs.
  for (const v of credentialVariants(cfg)) deps.secrets.add(v);
  deps.secrets.add(cfg.proxy.token);
  if (cfg.proxy.https !== null && cfg.proxy.token !== null && cfg.proxy.token.length > 0) {
    deps.secrets.add(proxyUrlWithToken(cfg.proxy.https, cfg.proxy.token));
  }

  const buildArgv = (r: ClaudeRunRequest): string[] => buildClaudeArgv(r, { platform: cfg.platform });
  const buildEnv = (r: ClaudeRunRequest): Record<string, string> => buildClaudeEnv(cfg, r, source);

  // The extension rule keys on the probed CLI version (§10.6, §10.9). The worker probes at startup;
  // a run on a runner that was never probed probes first (once), so the version always comes from it.
  let probed: ClaudeProbeResult | null = null;
  let probing: Promise<ClaudeProbeResult> | null = null;
  const probe = (): Promise<ClaudeProbeResult> => {
    probing ??= probeClaude(cfg, { logger: deps.logger, launcher: deps.launcher, env: source })
      .then((result) => {
        probed = result;
        return result;
      })
      .finally(() => {
        probing = null;
      });
    return probing;
  };
  const probedVersion = async (): Promise<string> => {
    const result = probed ?? (await probe());
    if (result.version === null) {
      throw new ClaudeProbeError('Claude CLI version is unknown', { details: { reason: 'version_unrecognized' } });
    }
    return result.version;
  };

  return {
    probe,
    buildArgv,
    buildEnv,
    async run(r: ClaudeRunRequest, h: ClaudeRunHandlers): Promise<ClaudeRunResult> {
      const argv = buildArgv(r);
      const launch = buildClaudeLaunchEnv(cfg, r, source);
      let cliVersion: string;
      if (r.signal.aborted) {
        // runClaude returns before spawning; nothing is probed for a run that never starts.
        cliVersion = probed?.version ?? '';
      } else {
        try {
          cliVersion = await probedVersion();
        } catch (e) {
          // A CLI that cannot be started is the same outcome as a failed Claude spawn.
          if (e instanceof ClaudeProbeError && e.details?.reason === 'spawn_failed') {
            deps.logger.error({ err: serializeError(e) }, 'claude spawn failed (probe before first run)');
            return emptyResult('spawn_failed', 0);
          }
          throw e;
        }
      }
      return runClaude(
        {
          cfg,
          logger: deps.logger,
          secrets: deps.secrets,
          launcher: deps.launcher,
          clock,
          argv,
          env: launch.env,
          credentialFd: launch.credentialFd,
          cliVersion,
        },
        r,
        h,
      );
    },
  };
}
