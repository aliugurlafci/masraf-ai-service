// Contract §1.2 "Allowed imports" as data. Single source for
// tests/unit/architecture/dependency-rules.test.ts and for the per-package
// no-restricted-imports blocks of eslint.config.js (enforcement rule T-M8).
//
// eslint.config.js loads this file with Node's built-in type stripping, so it may
// only use erasable TypeScript syntax and must not import relative modules.
import type { Linter } from 'eslint';
import { builtinModules } from 'node:module';

/** Every public `@orc/*` import specifier (package entry points, contract §1.1). */
export const ORC_ENTRIES = [
  '@orc/shared',
  '@orc/shared/node',
  '@orc/security',
  '@orc/logger',
  '@orc/database',
  '@orc/git-manager',
  '@orc/mcp-manager',
  '@orc/claude-runner',
  '@orc/task-manager',
  '@orc/project-manager',
  '@orc/orchestrator',
  '@orc/sandbox',
  '@orc/api',
  '@orc/worker',
  '@orc/runner',
  '@orc/egress-proxy',
  '@orc/web',
] as const;

export type OrcEntry = (typeof ORC_ENTRIES)[number];

export interface ScopeRule {
  /** Table row: the entry point implemented by the sources under `src`. */
  readonly entry: OrcEntry;
  /** Workspace directory of the owning package (repo-relative, POSIX). */
  readonly dir: string;
  /** Source root of this entry (repo-relative, POSIX). A nested rule's `src` belongs to that rule. */
  readonly src: string;
  /** `@orc/*` entries the sources may import (type-only imports included). */
  readonly allowed: readonly OrcEntry[];
  /** Browser runtime: `node:*`, bare Node built-ins and the `Buffer`/`process` globals are forbidden. */
  readonly browser: boolean;
}

const BASE: readonly OrcEntry[] = [
  '@orc/shared',
  '@orc/shared/node',
  '@orc/logger',
  '@orc/security',
];

/** Contract §1.2, row by row. Anything not listed is forbidden. */
export const IMPORT_RULES: readonly ScopeRule[] = [
  {
    entry: '@orc/shared',
    dir: 'packages/shared',
    src: 'packages/shared/src',
    allowed: [],
    browser: true,
  },
  {
    entry: '@orc/shared/node',
    dir: 'packages/shared',
    src: 'packages/shared/src/node',
    allowed: ['@orc/shared'],
    browser: false,
  },
  {
    entry: '@orc/security',
    dir: 'packages/security',
    src: 'packages/security/src',
    allowed: ['@orc/shared'],
    browser: false,
  },
  {
    entry: '@orc/logger',
    dir: 'packages/logger',
    src: 'packages/logger/src',
    allowed: ['@orc/shared', '@orc/security'],
    browser: false,
  },
  {
    entry: '@orc/database',
    dir: 'packages/database',
    src: 'packages/database/src',
    allowed: BASE,
    browser: false,
  },
  {
    entry: '@orc/git-manager',
    dir: 'packages/git-manager',
    src: 'packages/git-manager/src',
    allowed: BASE,
    browser: false,
  },
  {
    entry: '@orc/mcp-manager',
    dir: 'packages/mcp-manager',
    src: 'packages/mcp-manager/src',
    allowed: BASE,
    browser: false,
  },
  {
    entry: '@orc/claude-runner',
    dir: 'packages/claude-runner',
    src: 'packages/claude-runner/src',
    allowed: BASE,
    browser: false,
  },
  {
    entry: '@orc/task-manager',
    dir: 'packages/task-manager',
    src: 'packages/task-manager/src',
    allowed: [...BASE, '@orc/database'],
    browser: false,
  },
  {
    entry: '@orc/project-manager',
    dir: 'packages/project-manager',
    src: 'packages/project-manager/src',
    allowed: [...BASE, '@orc/database', '@orc/task-manager'],
    browser: false,
  },
  {
    entry: '@orc/orchestrator',
    dir: 'packages/orchestrator',
    src: 'packages/orchestrator/src',
    allowed: [
      ...BASE,
      '@orc/database',
      '@orc/task-manager',
      '@orc/git-manager',
      '@orc/mcp-manager',
      '@orc/claude-runner',
    ],
    browser: false,
  },
  {
    entry: '@orc/api',
    dir: 'apps/api',
    src: 'apps/api/src',
    allowed: [...BASE, '@orc/database', '@orc/task-manager', '@orc/project-manager'],
    browser: false,
  },
  {
    entry: '@orc/sandbox',
    dir: 'packages/sandbox',
    src: 'packages/sandbox/src',
    allowed: BASE,
    browser: false,
  },
  {
    entry: '@orc/worker',
    dir: 'apps/worker',
    src: 'apps/worker/src',
    allowed: [
      ...BASE,
      '@orc/database',
      '@orc/task-manager',
      '@orc/orchestrator',
      '@orc/git-manager',
      '@orc/mcp-manager',
      '@orc/claude-runner',
      '@orc/sandbox',
    ],
    browser: false,
  },
  {
    entry: '@orc/runner',
    dir: 'apps/runner',
    src: 'apps/runner/src',
    allowed: [...BASE, '@orc/sandbox'],
    browser: false,
  },
  {
    entry: '@orc/egress-proxy',
    dir: 'apps/egress-proxy',
    src: 'apps/egress-proxy/src',
    allowed: ['@orc/shared', '@orc/shared/node', '@orc/logger'],
    browser: false,
  },
  {
    entry: '@orc/web',
    dir: 'apps/web',
    src: 'apps/web/src',
    allowed: ['@orc/shared'],
    browser: true,
  },
];

/** ADR-0019: the API never touches repositories, workspaces or processes. */
export const API_FORBIDDEN: readonly OrcEntry[] = [
  '@orc/git-manager',
  '@orc/mcp-manager',
  '@orc/claude-runner',
  '@orc/orchestrator',
];

/** Node-only globals a browser scope must not reference. */
export const NODE_ONLY_GLOBALS = [
  'Buffer',
  'process',
  'global',
  'require',
  '__dirname',
  '__filename',
] as const;

/** Workspace package that owns an entry (`@orc/shared/node` -> `@orc/shared`). */
export function packageOf(specifier: string): string {
  const [scope = '', name = ''] = specifier.split('/');
  return `${scope}/${name}`;
}

export function isOrcSpecifier(specifier: string): boolean {
  return specifier === '@orc' || specifier.startsWith('@orc/');
}

export function isOrcEntry(specifier: string): specifier is OrcEntry {
  return (ORC_ENTRIES as readonly string[]).includes(specifier);
}

/** The rule whose `src` is the longest prefix of a repo-relative POSIX path, if any. */
export function ruleForPath(path: string): ScopeRule | undefined {
  let match: ScopeRule | undefined;
  for (const rule of IMPORT_RULES) {
    if (path.startsWith(`${rule.src}/`) && (!match || rule.src.length > match.src.length)) {
      match = rule;
    }
  }
  return match;
}

/** `@orc/*` entries a scope must not import. */
export function forbiddenEntries(rule: ScopeRule): OrcEntry[] {
  return ORC_ENTRIES.filter((entry) => !rule.allowed.includes(entry));
}

function restrictionMessage(rule: ScopeRule): string {
  const allowed = rule.allowed.length > 0 ? rule.allowed.join(', ') : 'no @orc/* entry';
  const runtime = rule.browser ? '; browser runtime: no node:* or Node built-ins' : '';
  return `contract §1.2: ${rule.entry} may import only ${allowed}${runtime}; deep imports (@orc/*/src/**) are forbidden`;
}

/** Bare Node built-in module names (prefix-only modules are covered by `node:*`). */
function bareBuiltinModules(): string[] {
  return builtinModules.filter((name) => !name.startsWith('node:') && !name.startsWith('_'));
}

/**
 * One flat-config block per §1.2 row:
 * `files: ['<src>/**']`, `no-restricted-imports` with
 * `patterns: [{ group: ['@orc/<forbidden>', '@orc/<forbidden>/**', '@orc/*\/src/**'] }]`;
 * browser rows additionally forbid `node:*`, bare Node built-ins and Node-only globals.
 */
export function restrictedImportConfigs(): Linter.Config[] {
  return IMPORT_RULES.map((rule) => {
    const message = restrictionMessage(rule);
    const group = [
      ...forbiddenEntries(rule).flatMap((entry) => [entry, `${entry}/**`]),
      '@orc/*/src/**',
    ];
    const nested = IMPORT_RULES.filter((other) => other.src.startsWith(`${rule.src}/`)).map(
      (other) => `${other.src}/**`,
    );
    const config: Linter.Config = {
      name: `orc/contract-1.2/${rule.entry}`,
      files: [`${rule.src}/**`],
      rules: {
        'no-restricted-imports': [
          'error',
          rule.browser
            ? {
                paths: bareBuiltinModules().map((name) => ({ name, message })),
                patterns: [{ group: [...group, 'node:*'], message }],
              }
            : { patterns: [{ group, message }] },
        ],
        ...(rule.browser
          ? {
              'no-restricted-globals': [
                'error',
                ...NODE_ONLY_GLOBALS.map((name) => ({
                  name,
                  message: `contract §1.2: ${rule.entry} is browser-safe; ${name} is Node-only`,
                })),
              ],
            }
          : {}),
      },
    };
    return nested.length > 0 ? { ...config, ignores: nested } : config;
  });
}
