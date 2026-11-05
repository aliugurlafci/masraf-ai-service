// Contract §1.2 enforcement (T-M8): every package.json "dependencies" lists exactly the
// @orc/* packages its sources import, and every import edge is in the §1.2 table.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  declaredDependencyViolations,
  extractImports,
  importViolations,
  isPackageNameStub,
  loadWorkspaces,
  undeclaredImportViolations,
  unusedDependencyViolations,
} from './dependency-analysis';
import type { SourceFile, WorkspacePackage } from './dependency-analysis';
import {
  API_FORBIDDEN,
  IMPORT_RULES,
  ORC_ENTRIES,
  forbiddenEntries,
  packageOf,
  ruleForPath,
} from './import-rules';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACES = loadWorkspaces(ROOT);
const PENDING = WORKSPACES.filter(isPackageNameStub).map((pkg) => pkg.name);

function rowFor(entry: string) {
  const rule = IMPORT_RULES.find((r) => r.entry === entry);
  if (!rule) throw new Error(`no §1.2 row for ${entry}`);
  return rule;
}

describe('contract §1.2 table', () => {
  it('has a row for every workspace package and a workspace for every row', () => {
    const rowPackages = [...new Set(IMPORT_RULES.map((r) => packageOf(r.entry)))].sort();
    expect(WORKSPACES.map((pkg) => pkg.name).sort()).toEqual(rowPackages);
    for (const rule of IMPORT_RULES) {
      const pkg = WORKSPACES.find((w) => w.name === packageOf(rule.entry));
      expect(pkg?.dir, rule.entry).toBe(rule.dir);
      expect(rule.src.startsWith(`${rule.dir}/src`), rule.entry).toBe(true);
    }
  });

  it('lists every row exactly once and only known entries', () => {
    expect(IMPORT_RULES.map((r) => r.entry).sort()).toEqual([...ORC_ENTRIES].sort());
    for (const rule of IMPORT_RULES) {
      expect(new Set(rule.allowed).size, rule.entry).toBe(rule.allowed.length);
      expect(rule.allowed, rule.entry).not.toContain(rule.entry);
    }
  });

  it('is acyclic at package level', () => {
    const edges = new Map<string, Set<string>>();
    for (const rule of IMPORT_RULES) {
      const from = packageOf(rule.entry);
      const targets = edges.get(from) ?? new Set<string>();
      for (const entry of rule.allowed) {
        if (packageOf(entry) !== from) targets.add(packageOf(entry));
      }
      edges.set(from, targets);
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const visit = (node: string, path: string[]): void => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'visiting') {
        cycles.push([...path, node].join(' -> '));
        return;
      }
      state.set(node, 'visiting');
      for (const next of edges.get(node) ?? []) visit(next, [...path, node]);
      state.set(node, 'done');
    };
    for (const node of edges.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  it('never allows importing an app or @orc/shared/node without @orc/shared', () => {
    const apps = WORKSPACES.filter((w) => w.dir.startsWith('apps/')).map((w) => w.name);
    for (const rule of IMPORT_RULES) {
      for (const app of apps) expect(rule.allowed, rule.entry).not.toContain(app);
      if (rule.allowed.includes('@orc/shared/node')) {
        expect(rule.allowed, rule.entry).toContain('@orc/shared');
      }
    }
  });

  it('keeps apps/api away from git-manager, mcp-manager, claude-runner and orchestrator (ADR-0019)', () => {
    expect(forbiddenEntries(rowFor('@orc/api'))).toEqual(
      expect.arrayContaining([...API_FORBIDDEN]),
    );
  });

  it('keeps apps/web on the @orc/shared main entry only, browser runtime', () => {
    expect(rowFor('@orc/web')).toMatchObject({ allowed: ['@orc/shared'], browser: true });
    expect(rowFor('@orc/shared')).toMatchObject({ allowed: [], browser: true });
  });

  it('keeps claude-runner, mcp-manager and orchestrator off @orc/sandbox', () => {
    for (const entry of ['@orc/claude-runner', '@orc/mcp-manager', '@orc/orchestrator']) {
      expect(rowFor(entry).allowed, entry).not.toContain('@orc/sandbox');
    }
  });

  it('maps nested sources to the most specific row', () => {
    expect(ruleForPath('packages/shared/src/node/process.ts')?.entry).toBe('@orc/shared/node');
    expect(ruleForPath('packages/shared/src/schemas/domain.ts')?.entry).toBe('@orc/shared');
    expect(ruleForPath('apps/web/src/App.tsx')?.entry).toBe('@orc/web');
    expect(ruleForPath('tests/unit/architecture/import-rules.ts')).toBeUndefined();
  });
});

describe.each(WORKSPACES)('$name ($dir)', (pkg) => {
  it('has sources under src/', () => {
    expect(pkg.sources.length).toBeGreaterThan(0);
  });

  it('imports only allowed @orc entries (no deep, cross-package relative or browser-unsafe imports)', () => {
    expect(importViolations(pkg)).toEqual([]);
  });

  it('declares only allowed @orc dependencies, all under "dependencies"', () => {
    expect(declaredDependencyViolations(pkg)).toEqual([]);
  });

  it('declares every @orc package its sources import', () => {
    expect(undeclaredImportViolations(pkg)).toEqual([]);
  });

  it('declares no unused @orc dependency', () => {
    expect(unusedDependencyViolations(pkg)).toEqual([]);
  });
});

it('no workspace is a PACKAGE_NAME stub (the unused-dependency check runs for every package)', () => {
  expect(PENDING).toEqual([]);
});

// ---- the analyzer itself, against synthetic sources -----------------------------------

function fakePackage(
  name: string,
  dir: string,
  dependencies: string[],
  sources: Record<string, string>,
  nonRuntimeOrcDependencies: string[] = [],
): WorkspacePackage {
  const files: SourceFile[] = Object.entries(sources).map(([path, text]) => ({
    path: `${dir}/src/${path}`,
    text,
  }));
  return { name, dir, dependencies, nonRuntimeOrcDependencies, sources: files };
}

describe('dependency analyzer (synthetic sources)', () => {
  it('extracts every import form, type-only included, with line numbers', () => {
    const text = [
      "import a from 'a';",
      "import type { B } from 'b';",
      "import 'c';",
      "export * from 'd';",
      "export { e } from 'e';",
      "export type { F } from 'f';",
      "const g = await import('g');",
      "const h = require('h');",
      "type I = import('i').I;",
      "import j = require('j');",
      "declare module 'k' {}",
      'const notAnImport = `l`;',
    ].join('\n');
    expect(extractImports('x/src/a.ts', text)).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map((specifier, i) => ({
        specifier,
        line: i + 1,
      })),
    );
  });

  it('flags a forbidden edge, including type-only imports', () => {
    const pkg = fakePackage('@orc/database', 'packages/database', ['@orc/shared'], {
      'index.ts': "import type { X } from '@orc/task-manager';\nimport '@orc/shared';\n",
    });
    expect(importViolations(pkg)).toEqual([
      "packages/database/src/index.ts:1 '@orc/task-manager': @orc/database -> @orc/task-manager is not allowed (contract §1.2)",
    ]);
  });

  it('flags deep imports, also into an allowed package', () => {
    const pkg = fakePackage('@orc/logger', 'packages/logger', ['@orc/shared'], {
      'index.ts': "export * from '@orc/shared/src/errors';\nimport '@orc/security/foo';\n",
    });
    const violations = importViolations(pkg);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.includes('deep import'))).toBe(true);
  });

  it('flags apps/api importing git-manager, mcp-manager, claude-runner or orchestrator', () => {
    const pkg = fakePackage('@orc/api', 'apps/api', [], {
      'main.ts': API_FORBIDDEN.map((entry) => `import '${entry}';`).join('\n'),
    });
    const violations = importViolations(pkg);
    expect(violations).toHaveLength(API_FORBIDDEN.length);
    expect(violations.every((v) => v.includes('ADR-0019'))).toBe(true);
  });

  it('flags apps/web importing @orc/shared/node or Node built-ins', () => {
    const pkg = fakePackage('@orc/web', 'apps/web', ['@orc/shared'], {
      'App.tsx':
        "import { a } from '@orc/shared';\nimport { b } from '@orc/shared/node';\nimport 'node:fs';\nimport 'path';\nimport 'fs/promises';\nexport const x = <p>{a}{b}</p>;\n",
    });
    expect(importViolations(pkg).map((v) => v.split(' ')[1])).toEqual([
      "'@orc/shared/node':",
      "'node:fs':",
      "'path':",
      "'fs/promises':",
    ]);
  });

  it('flags the @orc/shared main entry reaching node:* or the node subpath, not the reverse', () => {
    const pkg = fakePackage('@orc/shared', 'packages/shared', [], {
      'index.ts': "export * from './node/index';\nimport 'node:crypto';\n",
      'node/index.ts': "export * from '../index';\nimport 'node:fs';\nimport '@orc/shared';\n",
    });
    expect(importViolations(pkg)).toEqual([
      "packages/shared/src/index.ts:1 './node/index': relative import reaches @orc/shared/node sources; @orc/shared may not import @orc/shared/node (contract §1.2)",
      "packages/shared/src/index.ts:2 'node:crypto': @orc/shared is browser-safe; Node built-in imports are forbidden (contract §1.2)",
    ]);
  });

  it('flags relative imports that escape the package', () => {
    const pkg = fakePackage('@orc/git-manager', 'packages/git-manager', [], {
      'a/b.ts': "import '../../../security/src/index';\nimport '../../package.json';\n",
    });
    expect(importViolations(pkg)).toEqual([
      "packages/git-manager/src/a/b.ts:1 '../../../security/src/index': relative import escapes packages/git-manager; import other packages through their @orc entry (contract §1.1)",
    ]);
  });

  it('flags declared-but-forbidden, self and non-runtime @orc dependencies', () => {
    const pkg = fakePackage(
      '@orc/project-manager',
      'packages/project-manager',
      ['@orc/git-manager', '@orc/project-manager', '@orc/shared', 'zod'],
      { 'index.ts': "import '@orc/shared';\n" },
      ['@orc/logger'],
    );
    expect(declaredDependencyViolations(pkg)).toEqual([
      '@orc/project-manager declares forbidden dependency @orc/git-manager (contract §1.2)',
      '@orc/project-manager declares itself as a dependency',
      '@orc/project-manager lists @orc/logger outside "dependencies"; @orc/* edges belong in "dependencies" only (T-M8)',
    ]);
  });

  it('flags undeclared and unused @orc dependencies; self-references need no declaration', () => {
    const pkg = fakePackage('@orc/shared', 'packages/shared', [], {
      'node/index.ts': "import '@orc/shared';\n",
    });
    expect(undeclaredImportViolations(pkg)).toEqual([]);
    const logger = fakePackage('@orc/logger', 'packages/logger', ['@orc/shared', '@orc/security'], {
      'index.ts': "import type { X } from '@orc/shared';\nimport '@orc/database';\n",
    });
    expect(undeclaredImportViolations(logger)).toEqual([
      '@orc/logger imports @orc/database without declaring it in "dependencies" (T-M8)',
    ]);
    expect(unusedDependencyViolations(logger)).toEqual([
      '@orc/logger declares @orc/security but no source imports it (T-M8)',
    ]);
  });

  it('recognises only the single-line PACKAGE_NAME scaffold as a stub', () => {
    const stub = fakePackage('@orc/sandbox', 'packages/sandbox', ['@orc/shared'], {
      'index.ts': 'export const PACKAGE_NAME = "@orc/sandbox" as const;\n',
    });
    expect(isPackageNameStub(stub)).toBe(true);
    const other = fakePackage('@orc/sandbox', 'packages/sandbox', [], {
      'index.ts': "export const PACKAGE_NAME = '@orc/runner' as const;\n",
    });
    expect(isPackageNameStub(other)).toBe(false);
    const grown = fakePackage('@orc/sandbox', 'packages/sandbox', [], {
      'index.ts': "export const PACKAGE_NAME = '@orc/sandbox' as const;\n",
      'client.ts': 'export {};\n',
    });
    expect(isPackageNameStub(grown)).toBe(false);
  });
});
