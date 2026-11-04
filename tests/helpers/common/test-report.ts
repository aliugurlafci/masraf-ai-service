// `npm run test:report [-- <project> ...]` (contract §18.1 / §18.5, F19, requirements §5.9).
// Runs the standard Vitest projects one after another (never claude-live) with the built-in
// JUnit reporter and the @vitest/ui HTML reporter, writing local files only:
//   reports/junit-<project>.xml, reports/html/<project>/index.html and the overview
//   reports/html/index.html that links every project report of the run.
// Every selected project runs even when an earlier one fails; the exit code is 1 if any failed.
// Executed directly by Node (built-in type stripping): erasable syntax only, no relative imports.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STANDARD_PROJECTS = ['unit', 'integration', 'api', 'security', 'e2e', 'web'] as const;
export type StandardProject = (typeof STANDARD_PROJECTS)[number];

export const REPORT_DIR = 'reports';
export const HTML_REPORT_DIR = `${REPORT_DIR}/html`;
/** Vitest CLI reporter (path relative to the repo root) that writes one project's HTML report. */
export const HTML_REPORTER_MODULE = './tests/helpers/common/html-reporter.ts';
/** Must equal HTML_REPORT_DIR_ENV of html-reporter.ts (this file runs without relative imports). */
export const HTML_REPORT_DIR_ENV = 'ORC_TEST_REPORT_HTML_DIR';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function isStandardProject(name: string): name is StandardProject {
  return (STANDARD_PROJECTS as readonly string[]).includes(name);
}

/** Repo-relative (POSIX) JUnit file of a project. */
export function junitReportPath(project: StandardProject): string {
  return `${REPORT_DIR}/junit-${project}.xml`;
}

/** Repo-relative (POSIX) directory of a project's HTML report (index.html inside). */
export function htmlReportDir(project: StandardProject): string {
  return `${HTML_REPORT_DIR}/${project}`;
}

export function vitestArgs(project: StandardProject): string[] {
  return [
    'run',
    '--project',
    project,
    '--reporter=dot',
    '--reporter=junit',
    `--outputFile.junit=${junitReportPath(project)}`,
    `--reporter=${HTML_REPORTER_MODULE}`,
    '--includeTaskLocation',
  ];
}

/** Environment of one project run: the parent environment plus its HTML report directory. */
export function vitestEnv(project: StandardProject, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, [HTML_REPORT_DIR_ENV]: htmlReportDir(project) };
}

export interface ProjectResult {
  project: StandardProject;
  code: number;
}

function statusText(code: number): string {
  return code === 0 ? 'passed' : `FAILED (exit ${code})`;
}

/** Overview page reports/html/index.html: one link per project report of this run. */
export function renderHtmlIndex(results: readonly ProjectResult[]): string {
  const rows = results.map(
    ({ project, code }) =>
      `      <li><a href="./${project}/index.html">${project}</a> - ${statusText(code)} - <code>${junitReportPath(project)}</code></li>`,
  );
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Test reports</title>',
    '  </head>',
    '  <body>',
    '    <h1>Test reports</h1>',
    '    <ul>',
    ...rows,
    '    </ul>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/** No arguments: every standard project. Otherwise only the named standard projects. */
export function selectProjects(argv: readonly string[]): StandardProject[] {
  if (argv.length === 0) return [...STANDARD_PROJECTS];
  return argv.map((name) => {
    if (!isStandardProject(name)) {
      throw new Error(
        `test:report: unknown or non-standard project "${name}" (expected: ${STANDARD_PROJECTS.join(', ')})`,
      );
    }
    return name;
  });
}

function vitestEntry(): string {
  const manifestPath = createRequire(import.meta.url).resolve('vitest/package.json');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin =
    typeof manifest === 'object' && manifest !== null && 'bin' in manifest
      ? manifest.bin
      : undefined;
  const relative =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null && 'vitest' in bin && typeof bin.vitest === 'string'
        ? bin.vitest
        : undefined;
  if (!relative) throw new Error('test:report: cannot locate the vitest CLI entry');
  return join(dirname(manifestPath), relative);
}

function runProject(entry: string, project: StandardProject): Promise<number> {
  // A stale report must never stand in for a run that crashed before writing its own.
  rmSync(join(ROOT, junitReportPath(project)), { force: true });
  rmSync(join(ROOT, htmlReportDir(project)), { recursive: true, force: true });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...vitestArgs(project)], {
      cwd: ROOT,
      env: vitestEnv(project, process.env),
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const projects = selectProjects(argv);
  const entry = vitestEntry();
  const results: ProjectResult[] = [];
  for (const project of projects) {
    process.stdout.write(
      `\n[test:report] ${project} -> ${junitReportPath(project)}, ${htmlReportDir(project)}/index.html\n`,
    );
    results.push({ project, code: await runProject(entry, project) });
  }
  mkdirSync(join(ROOT, HTML_REPORT_DIR), { recursive: true });
  writeFileSync(join(ROOT, HTML_REPORT_DIR, 'index.html'), renderHtmlIndex(results), 'utf8');
  process.stdout.write('\n[test:report] summary\n');
  for (const { project, code } of results) {
    process.stdout.write(
      `  ${project.padEnd(12)} ${statusText(code)}  ${junitReportPath(project)}  ${htmlReportDir(project)}/index.html\n`,
    );
  }
  process.stdout.write(`  ${'overview'.padEnd(12)} ${HTML_REPORT_DIR}/index.html\n`);
  return results.some((r) => r.code !== 0) ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
