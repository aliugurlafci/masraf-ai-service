// eslint.config.js must carry one no-restricted-imports block per contract §1.2 row,
// generated from import-rules.ts. The resolved configuration of the real eslint.config.js
// is replayed through a Linter so the test proves the rules fire (and stay quiet when allowed).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  IMPORT_RULES,
  NODE_ONLY_GLOBALS,
  ORC_ENTRIES,
  restrictedImportConfigs,
} from './import-rules';
import type { ScopeRule } from './import-rules';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESTRICTION_RULES = ['no-restricted-imports', 'no-restricted-globals'] as const;

type RuleConfigs = Partial<Record<(typeof RESTRICTION_RULES)[number], Linter.RuleEntry>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuleEntry(value: unknown): value is Linter.RuleEntry {
  return (
    typeof value === 'number' ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.length > 0)
  );
}

function probeFile(rule: ScopeRule): string {
  return join(
    ROOT,
    rule.src,
    rule.browser && rule.dir === 'apps/web' ? '__probe__.tsx' : '__probe__.ts',
  );
}

const resolved = new Map<ScopeRule, RuleConfigs>();
const linter = new Linter({ cwd: ROOT, configType: 'flat' });

function lint(rule: ScopeRule, code: string): string[] {
  const configs = resolved.get(rule);
  if (!configs) throw new Error(`no resolved config for ${rule.entry}`);
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
      { files: ['**/*.ts', '**/*.tsx'], rules: configs },
    ],
    probeFile(rule),
  );
  const fatal = messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(fatal.map((m) => m.message).join('; '));
  return messages.map((m) => m.ruleId ?? 'unknown');
}

beforeAll(async () => {
  const eslint = new ESLint({ cwd: ROOT });
  for (const rule of IMPORT_RULES) {
    const config: unknown = await eslint.calculateConfigForFile(probeFile(rule));
    const rules = isRecord(config) && isRecord(config.rules) ? config.rules : {};
    const picked: RuleConfigs = {};
    for (const name of RESTRICTION_RULES) {
      const entry = rules[name];
      if (isRuleEntry(entry)) picked[name] = entry;
    }
    resolved.set(rule, picked);
  }
}, 60_000);

describe('eslint.config.js contract §1.2 blocks', () => {
  it('registers exactly the generated blocks', async () => {
    const mod: unknown = await import(pathToFileURL(join(ROOT, 'eslint.config.js')).href);
    const exported = isRecord(mod) && Array.isArray(mod.default) ? (mod.default as unknown[]) : [];
    const contractBlocks = exported.filter(
      (block) =>
        isRecord(block) &&
        typeof block.name === 'string' &&
        block.name.startsWith('orc/contract-1.2/'),
    );
    expect(contractBlocks).toEqual(restrictedImportConfigs());
  });

  it.each(IMPORT_RULES.map((rule) => [rule.entry, rule] as const))(
    '%s: forbidden @orc entries error, allowed ones pass',
    (_entry, rule) => {
      for (const entry of ORC_ENTRIES) {
        const ids = lint(rule, `import '${entry}';\n`);
        if (rule.allowed.includes(entry)) expect(ids, `${rule.entry} -> ${entry}`).toEqual([]);
        else expect(ids, `${rule.entry} -> ${entry}`).toEqual(['no-restricted-imports']);
      }
    },
  );

  it.each(IMPORT_RULES.map((rule) => [rule.entry, rule] as const))(
    '%s: deep imports, type-only and re-export forms error',
    (_entry, rule) => {
      const forbidden = ORC_ENTRIES.find((entry) => !rule.allowed.includes(entry));
      expect(lint(rule, "import '@orc/shared/src/index';\n")).toEqual(['no-restricted-imports']);
      expect(lint(rule, "export * from '@orc/database/src/repositories/tasks';\n")).toEqual([
        'no-restricted-imports',
      ]);
      expect(lint(rule, `import type { X } from '${forbidden}';\nexport type { X };\n`)).toEqual([
        'no-restricted-imports',
      ]);
      expect(lint(rule, `export { y } from '${forbidden}';\n`)).toEqual(['no-restricted-imports']);
    },
  );

  it.each(IMPORT_RULES.map((rule) => [rule.entry, rule] as const))(
    '%s: Node built-ins and globals are forbidden only in browser rows',
    (_entry, rule) => {
      const expected = rule.browser ? ['no-restricted-imports'] : [];
      for (const specifier of ['node:fs', 'fs', 'fs/promises', 'path', 'node:test']) {
        expect(lint(rule, `import '${specifier}';\n`), specifier).toEqual(expected);
      }
      for (const name of NODE_ONLY_GLOBALS) {
        expect(lint(rule, `export const v = ${name};\n`), name).toEqual(
          rule.browser ? ['no-restricted-globals'] : [],
        );
      }
      expect(lint(rule, "import { z } from 'zod';\nexport const s = z.string();\n")).toEqual([]);
    },
  );
});
