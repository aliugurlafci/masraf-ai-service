import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
// Contract §1.2 import table (single source, shared with tests/unit/architecture).
// Loaded through Node's built-in TypeScript type stripping (Node >= 24, see .nvmrc).
import { restrictedImportConfigs } from './tests/unit/architecture/import-rules.ts';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/node_modules/**',
    'workspaces/**',
    'projects/**',
    'secrets/**',
    'test-results/**',
    'reports/**',
    '.codebase-memory/**',
  ]),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'error' },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
  // One no-restricted-imports block per contract §1.2 row (T-M8).
  ...restrictedImportConfigs(),
  {
    files: ['scripts/**', 'tests/fixtures/**'],
    rules: { 'no-console': 'off' },
  },
);
