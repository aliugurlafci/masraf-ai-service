import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Contract §1.2 / ADR-0002: the @orc/shared main entry is browser-safe.
const SRC = fileURLToPath(new URL('../../../packages/shared/src/', import.meta.url));

function mainEntryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node' ? [] : mainEntryFiles(full);
    return d.name.endsWith('.ts') ? [full] : [];
  });
}

describe('@orc/shared main entry is browser-safe', () => {
  const files = mainEntryFiles(SRC);

  it('finds the main-entry sources', () => {
    expect(files.map((f) => relative(SRC, f).split(sep).join('/'))).toContain('index.ts');
  });

  it.each(files.map((f) => [relative(SRC, f).split(sep).join('/'), f] as const))(
    '%s has no node-only references',
    (_name, file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/from\s+['"]node:/);
      expect(code).not.toMatch(/from\s+['"]\.{1,2}\/node(\/|['"])/);
      expect(code).not.toMatch(/\bBuffer\b/);
      expect(code).not.toMatch(/\bprocess\./);
      expect(code).not.toMatch(/\brequire\(/);
    },
  );

  it('package.json exports the node subpath separately', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './node': './src/node/index.ts' });
  });
});
