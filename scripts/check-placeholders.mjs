#!/usr/bin/env node
// Placeholder gate (CLAUDE.md engineering rules, requirements §16): production sources must not
// contain unfinished-work markers. Scans apps/*/src, packages/*/src, docker/ and scripts/ for the
// markers below and exits 1 listing every finding (path:line), 0 when clean, 2 on usage errors.
//
//   node scripts/check-placeholders.mjs [--root <dir>] [--json]
//
// Allow-list (deliberately minimal):
//   1. Inline: a line containing `check-placeholders: allow` (or the line right after such a comment)
//      is skipped. Use it only with a reason in the same comment.
//   2. ALLOW below: exact path + literal text, each with a reason. Test files (*.test.ts[x], test/
//      directories) are not production sources and are not scanned.
//   3. UI wording: in apps/web the HTML/JSX/CSS `placeholder` attribute and `::placeholder` selector
//      name an input hint, not unfinished code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SELF), '..');

/** Unfinished-work markers. Upper-case tags are matched case-sensitively, phrases case-insensitively. */
const MARKERS = [
  { name: 'TODO', pattern: /\bTODO\b/ },
  { name: 'FIXME', pattern: /\bFIXME\b/ },
  { name: 'XXX', pattern: /\bXXX\b/ },
  { name: 'placeholder', pattern: /placeholder/i },
  { name: 'not implemented', pattern: /\bnot[\s_-]+implemented\b/i },
];

const INLINE_ALLOW = 'check-placeholders: allow';

/** Reviewed exceptions: repository-relative POSIX path + literal text on the line. */
const ALLOW = [
  {
    path: 'apps/web/src/components/States.tsx',
    text: 'Skeleton placeholder for a loading data view',
    reason: 'UI loading skeleton (a finished component), not unfinished code',
  },
  {
    path: 'scripts/check-placeholders.mjs',
    text: '',
    reason: 'this gate defines the markers it searches for',
  },
];

/** `placeholder` as an input-hint attribute/selector in web UI code. */
const UI_PLACEHOLDER = /(::?placeholder\b|\bplaceholder\s*[=:])/gi;

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json', '.sql', '.sh', '.ps1',
  '.yml', '.yaml', '.conf', '.css', '.html', '.toml', '.ini', '.env', '.txt',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.turbo', 'test', '__tests__']);

function isTestFile(name) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

function isScannable(name) {
  if (/^Dockerfile(\..+)?$/.test(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot));
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && isScannable(entry.name) && !isTestFile(entry.name)) {
      out.push(full);
    }
  }
}

function listDirs(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(parent, e.name));
  } catch {
    return [];
  }
}

/** Production source roots: apps/*\/src, packages/*\/src, docker, scripts. */
export function productionRoots(root) {
  const roots = [];
  for (const group of ['apps', 'packages']) {
    for (const dir of listDirs(join(root, group))) roots.push(join(dir, 'src'));
  }
  roots.push(join(root, 'docker'), join(root, 'scripts'));
  return roots.filter((r) => {
    try {
      return statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function allowedByList(relPath, line) {
  return ALLOW.some((a) => a.path === relPath && line.includes(a.text));
}

/** Scans `root`; returns { files, findings: [{ path, line, marker, text }] }. */
export function scan(root) {
  const files = [];
  for (const dir of productionRoots(root)) walk(dir, files);
  const findings = [];
  for (const file of files) {
    const relPath = toPosix(relative(root, file));
    const isWeb = relPath.startsWith('apps/web/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (raw.includes(INLINE_ALLOW) || (i > 0 && lines[i - 1].includes(INLINE_ALLOW))) continue;
      if (allowedByList(relPath, raw)) continue;
      const line = isWeb ? raw.replace(UI_PLACEHOLDER, '') : raw;
      for (const marker of MARKERS) {
        if (marker.pattern.test(line)) {
          findings.push({ path: relPath, line: i + 1, marker: marker.name, text: raw.trim().slice(0, 160) });
        }
      }
    }
  }
  return { files: files.length, findings };
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: { root: { type: 'string' }, json: { type: 'boolean', default: false } },
      strict: true,
    }));
  } catch (err) {
    console.error(`check-placeholders: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const root = resolve(values.root ?? DEFAULT_ROOT);
  const result = scan(root);
  if (values.json) {
    console.log(JSON.stringify({ gate: 'check-placeholders', root, ...result, passed: result.findings.length === 0 }));
  } else {
    for (const f of result.findings) console.error(`${f.path}:${f.line}: ${f.marker}: ${f.text}`);
    console.log(
      `check-placeholders: ${result.files} files scanned, ${result.findings.length} finding(s)` +
        (result.findings.length === 0 ? ' - gate passed' : ' - gate FAILED'),
    );
  }
  return result.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) {
  process.exitCode = main();
}
