// K6 (B-009): the leak guard knows every temp-dir prefix of the tests by an EXPLICIT list (LEAK_DIR_PREFIXES). This
// synchronous test scans tests/** for the prefixes that are really used and fails on an unlisted one, on a prefix that
// is built at run time (cannot be verified) and on a listed prefix that would also match directories the product or
// the test environment create (orc-cbm-rt-<uid>, orc-test-home).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLeakDirName, LEAK_DIR_PREFIXES } from '../../setup/leak-ledger';

const TESTS_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/**
 * Files that are NOT checked, each with its reason (the only way to exempt something). Keys are paths relative to
 * tests/, with forward slashes.
 */
const EXCLUDED_FILES: Readonly<Record<string, string>> = {
  'unit/architecture/test-prefixes.test.ts':
    'this scanner: its regular expressions and fixtures contain the patterns it looks for',
  'unit/architecture/test-helpers.test.ts':
    'intentional orc-helper-* directories that exercise the temp-dir helpers themselves (cleanup is the subject)',
  'helpers/common/temp-dir.ts':
    'generic helper: the prefix is a parameter (default orc-test-); every caller is scanned',
  'helpers/common/vitest-hooks.ts':
    'generic hook: forwards options.prefix to createTempDir; every caller is scanned',
  'helpers/git/fixtures.ts': 'generic helper makeTempDir(prefix); every caller is scanned',
  'helpers/sandbox/roots.ts':
    'generic helper makeRoots(prefix = orc-sandbox-); every caller is scanned',
  'helpers/common/leak-fixtures.ts':
    'guard fixtures: the prefixes are chosen by tests/integration/leak-detection.test.ts, which asserts them',
  'integration/worker/fake-runner.ts':
    'builds a unix socket FILE name below tmpdir (orc-fr-<id>.sock), not a directory; the guard only scans directories',
};

interface Use {
  readonly file: string;
  readonly line: number;
  /** The literal prefix, or null when it is built at run time. */
  readonly prefix: string | null;
  readonly source: string;
}

const STRING_ARG = String.raw`'[^'\n]*'|"[^"\n]*"|\x60[^\x60\n]*\x60|[A-Za-z_$][\w$.]*`;
// join(tmpdir(), ARG) / path.join(await realpath(tmpdir()), ARG)
const JOIN_TMP = new RegExp(
  String.raw`(?:\w+\.)?join\(\s*(?:await\s+realpath\(\s*)?(?:os\.)?tmpdir\(\)\s*\)?\s*,\s*(${STRING_ARG})\s*[,)]`,
  'y',
);
const MKDTEMP = /\bmkdtemp(?:Sync)?\(/g;
const WRAPPER = new RegExp(String.raw`\b(createTempDir|makeTempDir|makeRoots)\(\s*(${STRING_ARG})?\s*[,)]`, 'g');
const WITH_TEMP_DIR = /\bwithTempDir\(/g;
const USE_TEMP_DIR = /\buseTempDir\(\s*([^)]*)\)/g;

/** The literal text of a quoted argument; null for identifiers and templates with substitutions. */
function literalOf(arg: string): string | null {
  const quote = arg.charAt(0);
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const body = arg.slice(1, -1);
  return quote === '`' && body.includes('${') ? null : body;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Blanks out whole-line comments (same length, so offsets and line numbers stay valid). */
function withoutLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? line.replace(/[^\r]/g, ' ') : line))
    .join('\n');
}

function scanSource(file: string, raw: string): Use[] {
  const text = withoutLineComments(raw);
  const uses: Use[] = [];
  const add = (index: number, prefix: string | null, source: string): void => {
    uses.push({ file, line: lineOf(text, index), prefix, source });
  };
  for (const m of text.matchAll(MKDTEMP)) {
    JOIN_TMP.lastIndex = m.index + m[0].length;
    const joined = JOIN_TMP.exec(text);
    if (!joined) add(m.index, null, 'mkdtemp without a recognizable join(tmpdir(), <prefix>)');
    else add(m.index, literalOf(joined[1] ?? ''), `mkdtemp(${joined[1] ?? ''})`);
  }
  for (const m of text.matchAll(WRAPPER)) {
    const arg = m[2];
    if (arg === undefined) continue; // default prefix of the helper
    add(m.index, literalOf(arg), `${m[1] ?? ''}(${arg})`);
  }
  for (const m of text.matchAll(WITH_TEMP_DIR)) add(m.index, null, 'withTempDir (unsupported form)');
  for (const m of text.matchAll(USE_TEMP_DIR)) {
    const args = (m[1] ?? '').trim();
    if (args === '') continue;
    if (!args.startsWith('{')) {
      add(m.index, null, `useTempDir(${args})`);
      continue;
    }
    const prefix = new RegExp(String.raw`\bprefix\s*:\s*(${STRING_ARG})`).exec(args)?.[1];
    if (prefix !== undefined) add(m.index, literalOf(prefix), `useTempDir(prefix: ${prefix})`);
    else if (/\bprefix\b/.test(args)) add(m.index, null, `useTempDir(${args})`);
  }
  return uses;
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile() && SCANNED.test(entry.name)) out.push(full);
  }
  return out;
}

function scanTests(): Use[] {
  const uses: Use[] = [];
  for (const full of listFiles(TESTS_ROOT)) {
    const rel = path.relative(TESTS_ROOT, full).split(path.sep).join('/');
    if (rel in EXCLUDED_FILES) continue;
    uses.push(...scanSource(rel, readFileSync(full, 'utf8')));
  }
  return uses;
}

describe('leak guard prefix list (K6)', () => {
  it('lists every temp-dir prefix used by tests/** and their helpers, and none is built at run time', () => {
    const uses = scanTests();
    const dynamic = uses.filter((u) => u.prefix === null).map((u) => `${u.file}:${u.line} ${u.source}`);
    const unlisted = uses
      .filter((u) => u.prefix !== null && !LEAK_DIR_PREFIXES.includes(u.prefix))
      .map((u) => `${u.file}:${u.line} ${u.prefix ?? ''}`);
    expect(dynamic, 'prefixes that are not string literals (cannot be verified)').toEqual([]);
    expect(unlisted, 'prefixes missing from LEAK_DIR_PREFIXES in tests/setup/leak-ledger.ts').toEqual([]);
    expect(uses.length, 'the scan found the known call sites').toBeGreaterThan(20);
  });

  it('keeps every exclusion real (the file exists) so a rename cannot silently widen the exemption', () => {
    const existing = new Set(
      listFiles(TESTS_ROOT).map((f) => path.relative(TESTS_ROOT, f).split(path.sep).join('/')),
    );
    for (const file of Object.keys(EXCLUDED_FILES)) expect(existing.has(file), file).toBe(true);
  });

  it('the list has no duplicates and every entry is a well-formed prefix ending with a dash', () => {
    expect(new Set(LEAK_DIR_PREFIXES).size).toBe(LEAK_DIR_PREFIXES.length);
    for (const prefix of LEAK_DIR_PREFIXES) {
      expect(prefix, prefix).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-$/);
    }
  });

  it('never matches directories of the product or the test environment (orc-cbm-rt-<uid>, orc-test-home)', () => {
    const foreign = [
      'orc-cbm-rt-0',
      'orc-cbm-rt-1000',
      'orc-cbm-rt-100000', // a 6 digit uid alone satisfies the 6 character rule after the product prefix
      'orc-cbm-rt-999999',
      'orc-test-home',
      'orc-test-only-redis-pw',
    ];
    for (const name of foreign) expect(isLeakDirName(name), name).toBe(false);
    for (const prefix of LEAK_DIR_PREFIXES) {
      for (const name of foreign) {
        expect(name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length)), `${prefix} / ${name}`).toBe(false);
      }
    }
    expect(isLeakDirName('orc-cbm-rt-100000')).toBe(false);
  });

  it('accepts exactly <listed prefix> + 6 alphanumerics', () => {
    for (const prefix of LEAK_DIR_PREFIXES) {
      expect(isLeakDirName(`${prefix}aB3dE9`), prefix).toBe(true);
      expect(isLeakDirName(`${prefix}aB3dE`), prefix).toBe(false);
      expect(isLeakDirName(`${prefix}aB3dE9x`), prefix).toBe(false);
      expect(isLeakDirName(`${prefix}aB3d-9`), prefix).toBe(false);
      expect(isLeakDirName(prefix), prefix).toBe(false);
    }
  });

  describe('scanner', () => {
    it('reads literal prefixes from mkdtemp, wrappers and useTempDir', () => {
      const src = [
        "const a = await mkdtemp(join(tmpdir(), 'orc-a-'));",
        "const b = mkdtempSync(path.join(os.tmpdir(), 'orc-b-'));",
        "const c = await mkdtemp(path.join(await realpath(tmpdir()), 'orc-c1-'));",
        "makeTempDir('orc-d-'); makeRoots(); createTempDir(\"orc-e-\");",
        "useTempDir({ scope: 'all', prefix: 'orc-f-' }); useTempDir();",
        "// mkdtemp(join(tmpdir(), 'orc-comment-'))",
      ].join('\n');
      expect(scanSource('x.ts', src).map((u) => u.prefix)).toEqual([
        'orc-a-',
        'orc-b-',
        'orc-c1-',
        'orc-d-',
        'orc-e-',
        'orc-f-',
      ]);
    });

    it('flags prefixes built at run time and mkdtemp calls it cannot read', () => {
      const src = [
        'mkdtemp(join(tmpdir(), prefix));',
        'mkdtemp(join(tmpdir(), `orc-${name}-`));',
        "mkdtempSync(somewhere + 'orc-');",
        'makeTempDir(prefix);',
        'useTempDir(options);',
        'useTempDir({ prefix });',
        'withTempDir(fn);',
      ].join('\n');
      const uses = scanSource('x.ts', src);
      expect(uses).toHaveLength(7);
      expect(uses.every((u) => u.prefix === null)).toBe(true);
    });
  });
});
