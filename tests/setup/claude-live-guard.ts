// Opt-in guard for the claude-live Vitest project (contract §18.1: "config throws unless CLAUDE_LIVE=1").
// The real Claude CLI is only ever reached through `npm run test:claude-live`, which sets CLAUDE_LIVE=1.
// vitest.config.ts calls assertClaudeLiveOptIn() while it is evaluated, and the claude-live project lists this
// module as its FIRST globalSetup so the run also aborts before any test infrastructure is touched.

export const CLAUDE_LIVE_PROJECT = 'claude-live';
export const CLAUDE_LIVE_ENV = 'CLAUDE_LIVE';

export const CLAUDE_LIVE_OPT_IN_MESSAGE =
  'The claude-live Vitest project runs the REAL Claude Code CLI and is opt-in only: ' +
  'run `npm run test:claude-live` (it sets CLAUDE_LIVE=1). Refusing to run it because CLAUDE_LIVE is not "1".';

/** True only for exactly CLAUDE_LIVE=1. */
export function isClaudeLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CLAUDE_LIVE_ENV] === '1';
}

/** The `--project` filters of a Vitest command line (`--project x`, `--project=x`). */
export function requestedProjectFilters(argv: readonly string[]): string[] {
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--project') {
      const next = argv[i + 1];
      if (next !== undefined) filters.push(next);
      i += 1;
    } else if (arg.startsWith('--project=')) {
      filters.push(arg.slice('--project='.length));
    }
  }
  return filters;
}

function filterMatches(filter: string, project: string): boolean {
  if (filter.startsWith('!')) return false;
  const pattern = filter
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(project);
}

/** True when the command line selects the claude-live project explicitly or through a wildcard filter. */
export function requestsClaudeLive(argv: readonly string[]): boolean {
  return requestedProjectFilters(argv).some((filter) => filterMatches(filter, CLAUDE_LIVE_PROJECT));
}

/** Throws the opt-in error when claude-live is requested on the command line without CLAUDE_LIVE=1. */
export function assertClaudeLiveOptIn(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (requestsClaudeLive(argv) && !isClaudeLiveEnabled(env)) {
    throw new Error(CLAUDE_LIVE_OPT_IN_MESSAGE);
  }
}

/** globalSetup of the claude-live project: aborts before global-infra unless CLAUDE_LIVE=1. */
export default function setup(): void {
  if (!isClaudeLiveEnabled(process.env)) throw new Error(CLAUDE_LIVE_OPT_IN_MESSAGE);
}
