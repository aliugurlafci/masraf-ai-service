// Production source files for static security scans (apps/*/src, packages/*/src; tests excluded).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './deployment';

export interface SourceFile {
  /** Repository-relative POSIX path. */
  readonly rel: string;
  readonly text: string;
}

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'test', '__tests__']);

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(full, out);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(e.name) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) {
      out.push(full);
    }
  }
}

export function productionSources(): SourceFile[] {
  const files: string[] = [];
  for (const group of ['apps', 'packages']) {
    for (const d of readdirSync(path.join(REPO_ROOT, group), { withFileTypes: true })) {
      if (d.isDirectory()) walk(path.join(REPO_ROOT, group, d.name, 'src'), files);
    }
  }
  return files.sort().map((f) => ({
    rel: path.relative(REPO_ROOT, f).split(path.sep).join('/'),
    text: readFileSync(f, 'utf8'),
  }));
}

/** Source text with comments and string/template literal contents blanked (keeps code structure). */
export function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    const n = text[i + 1] ?? '';
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
