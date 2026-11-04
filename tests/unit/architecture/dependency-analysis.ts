// Static analysis behind dependency-rules.test.ts (contract §1.2, enforcement rule T-M8).
// Pure functions over a workspace model so the checks can be exercised against
// synthetic sources as well as the real repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix } from 'node:path';
import ts from 'typescript';
import {
  API_FORBIDDEN,
  IMPORT_RULES,
  isOrcEntry,
  isOrcSpecifier,
  packageOf,
  ruleForPath,
} from './import-rules';

export interface ImportRef {
  readonly specifier: string;
  readonly line: number;
}

export interface SourceFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly text: string;
}

export interface WorkspacePackage {
  readonly name: string;
  /** Repo-relative POSIX directory. */
  readonly dir: string;
  /** Keys of package.json "dependencies". */
  readonly dependencies: readonly string[];
  /** `@orc/*` keys found in devDependencies, peerDependencies or optionalDependencies. */
  readonly nonRuntimeOrcDependencies: readonly string[];
  /** Every source file under `<dir>/src`. */
  readonly sources: readonly SourceFile[];
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const PACKAGE_NAME_STUB = /^export const PACKAGE_NAME = (['"])(@orc\/[a-z0-9-]+)\1 as const;$/;

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Every module specifier of a source file: `import`/`export ... from`, side-effect imports,
 * `import x = require()`, dynamic `import()`, `require()`, `import('x').T` type queries and
 * `declare module 'x'` augmentations. Type-only forms are included (T-M8).
 */
export function extractImports(path: string, text: string): ImportRef[] {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const refs: ImportRef[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      refs.push({ specifier: node.text, line: line + 1 });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return refs;
}

/** True while the package sources are still the single-line `PACKAGE_NAME` scaffold. */
export function isPackageNameStub(pkg: WorkspacePackage): boolean {
  const [only, ...rest] = pkg.sources;
  if (!only || rest.length > 0) return false;
  return PACKAGE_NAME_STUB.exec(only.text.trim())?.[2] === pkg.name;
}

/** `@orc/*` packages the workspace may depend on (union of its rows, minus itself). */
export function allowedPackages(pkg: WorkspacePackage): Set<string> {
  const allowed = new Set<string>();
  for (const rule of IMPORT_RULES) {
    if (rule.dir !== pkg.dir) continue;
    for (const entry of rule.allowed) allowed.add(packageOf(entry));
  }
  allowed.delete(pkg.name);
  return allowed;
}

/** `@orc/*` packages imported by the sources (self-references excluded). */
export function importedPackages(pkg: WorkspacePackage): Set<string> {
  const used = new Set<string>();
  for (const file of pkg.sources) {
    for (const { specifier } of extractImports(file.path, file.text)) {
      if (isOrcSpecifier(specifier)) used.add(packageOf(specifier));
    }
  }
  used.delete(pkg.name);
  return used;
}

function relativeImportViolation(
  file: SourceFile,
  specifier: string,
  pkg: WorkspacePackage,
): string | undefined {
  const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
  if (target !== pkg.dir && !target.startsWith(`${pkg.dir}/`)) {
    return `relative import escapes ${pkg.dir}; import other packages through their @orc entry (contract §1.1)`;
  }
  const from = ruleForPath(file.path);
  const to = ruleForPath(`${target}/`);
  if (from && to && to !== from && !from.allowed.includes(to.entry)) {
    return `relative import reaches ${to.entry} sources; ${from.entry} may not import ${to.entry} (contract §1.2)`;
  }
  return undefined;
}

function specifierViolation(
  file: SourceFile,
  specifier: string,
  pkg: WorkspacePackage,
): string | undefined {
  const rule = ruleForPath(file.path);
  if (!rule || rule.dir !== pkg.dir) {
    return `no contract §1.2 row covers ${file.path}`;
  }
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier === '.' ||
    specifier === '..'
  ) {
    return relativeImportViolation(file, specifier, pkg);
  }
  if (posix.isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier)) {
    return 'absolute path import';
  }
  if (isOrcSpecifier(specifier)) {
    if (!isOrcEntry(specifier)) {
      return 'deep import; only package entry points (@orc/<pkg>, @orc/shared/node) are public (contract §1.1)';
    }
    if (!rule.allowed.includes(specifier)) {
      const adr =
        rule.entry === '@orc/api' && API_FORBIDDEN.includes(specifier)
          ? ' (ADR-0019: the API never touches repositories, workspaces or processes)'
          : '';
      return `${rule.entry} -> ${specifier} is not allowed (contract §1.2)${adr}`;
    }
    return undefined;
  }
  if (rule.browser && (specifier.startsWith('node:') || isBuiltin(specifier))) {
    return `${rule.entry} is browser-safe; Node built-in imports are forbidden (contract §1.2)`;
  }
  return undefined;
}

/** Specifier-level violations: forbidden edges, deep imports, browser Node imports, path escapes. */
export function importViolations(pkg: WorkspacePackage): string[] {
  const violations: string[] = [];
  for (const file of pkg.sources) {
    for (const { specifier, line } of extractImports(file.path, file.text)) {
      const reason = specifierViolation(file, specifier, pkg);
      if (reason) violations.push(`${file.path}:${line} '${specifier}': ${reason}`);
    }
  }
  return violations;
}

/** Declared `@orc/*` dependencies that the table forbids (a forbidden edge is a violation even if unused). */
export function declaredDependencyViolations(pkg: WorkspacePackage): string[] {
  const allowed = allowedPackages(pkg);
  const violations: string[] = [];
  for (const dep of pkg.dependencies) {
    if (!isOrcSpecifier(dep)) continue;
    if (dep === pkg.name) violations.push(`${pkg.name} declares itself as a dependency`);
    else if (!allowed.has(dep))
      violations.push(`${pkg.name} declares forbidden dependency ${dep} (contract §1.2)`);
  }
  for (const dep of pkg.nonRuntimeOrcDependencies) {
    violations.push(
      `${pkg.name} lists ${dep} outside "dependencies"; @orc/* edges belong in "dependencies" only (T-M8)`,
    );
  }
  return violations;
}

/** `@orc/*` packages imported by the sources but missing from "dependencies". */
export function undeclaredImportViolations(pkg: WorkspacePackage): string[] {
  const declared = new Set(pkg.dependencies);
  return [...importedPackages(pkg)]
    .filter((dep) => !declared.has(dep))
    .map((dep) => `${pkg.name} imports ${dep} without declaring it in "dependencies" (T-M8)`);
}

/** Declared `@orc/*` dependencies that no source imports. */
export function unusedDependencyViolations(pkg: WorkspacePackage): string[] {
  const used = importedPackages(pkg);
  return pkg.dependencies
    .filter((dep) => isOrcSpecifier(dep) && dep !== pkg.name && !used.has(dep))
    .map((dep) => `${pkg.name} declares ${dep} but no source imports it (T-M8)`);
}

// ---- repository loading ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

function dependencyKeys(manifest: Record<string, unknown>, field: string): string[] {
  const value = manifest[field];
  return isRecord(value) ? Object.keys(value) : [];
}

function listSources(root: string, relDir: string): SourceFile[] {
  const absDir = join(root, relDir);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : listSources(root, rel);
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) return [];
      return [{ path: rel, text: readFileSync(join(root, rel), 'utf8') }];
    });
}

/** Workspace directories from the root package.json `workspaces` (`<dir>/*` globs). */
export function workspaceDirs(root: string): string[] {
  const manifest = readJson(join(root, 'package.json'));
  const globs: unknown = manifest.workspaces;
  if (!Array.isArray(globs)) throw new Error('root package.json has no "workspaces" array');
  return (globs as unknown[]).flatMap((glob) => {
    if (typeof glob !== 'string' || !/^[\w.-]+\/\*$/.test(glob)) {
      throw new Error(`unsupported workspaces pattern ${String(glob)}`);
    }
    const parent = glob.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .filter((dir) => existsSync(join(root, dir, 'package.json')))
      .sort();
  });
}

export function loadWorkspaces(root: string): WorkspacePackage[] {
  return workspaceDirs(root).map((dir) => {
    const manifest = readJson(join(root, dir, 'package.json'));
    if (typeof manifest.name !== 'string') throw new Error(`${dir}/package.json has no name`);
    const nonRuntime = ['devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
      (field) => dependencyKeys(manifest, field).filter(isOrcSpecifier),
    );
    return {
      name: manifest.name,
      dir,
      dependencies: dependencyKeys(manifest, 'dependencies'),
      nonRuntimeOrcDependencies: nonRuntime,
      sources: listSources(root, `${dir}/src`),
    };
  });
}
