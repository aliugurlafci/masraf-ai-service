import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import type { TestProjectInlineConfiguration } from 'vitest/config';
import { assertClaudeLiveOptIn, isClaudeLiveEnabled } from './tests/setup/claude-live-guard.js';

// Real Claude Code is never invoked by the standard suites. The claude-live project only exists when
// CLAUDE_LIVE=1 (set by `npm run test:claude-live`); selecting it with --project without that flag throws (§18.1).
assertClaudeLiveOptIn(process.argv, process.env);
const claudeLiveEnabled = isClaudeLiveEnabled(process.env);

// §18.2: guard + drop/recreate orchestrator_test via orc-db bootstrap, migrate and seed. Shared by every
// infrastructure project of one run (prepared once, released after the last project).
const GLOBAL_INFRA = 'tests/setup/global-infra.ts';
// B-005 leak guard: snapshot after GLOBAL_INFRA, diff/report (ORC_TEST_REAP=1 reaps, ORC_TEST_LEAK_STRICT=1 fails)
// before GLOBAL_INFRA releases (teardowns run in reverse order). Shared by the infrastructure projects of one run.
const LEAK_GUARD = 'tests/setup/global-teardown.ts';
const INFRA_GLOBAL_SETUP = [GLOBAL_INFRA, LEAK_GUARD];
// Records each worker's PID and time window in the file task meta (Windows orphan attribution of the leak guard).
const LEAK_WORKER = 'tests/setup/leak-worker.ts';

const projects: TestProjectInlineConfiguration[] = [
  {
    extends: true,
    test: {
      name: 'unit',
      environment: 'node',
      include: ['tests/unit/**/*.test.ts'],
      // Unit tests are fast, but cold source transforms of whole packages under full file parallelism on a
      // Windows dev host have exceeded the 5 s default; slow tests still declare their own explicit budgets.
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  },
  {
    extends: true,
    test: {
      name: 'integration',
      environment: 'node',
      include: ['tests/integration/**/*.test.ts'],
      globalSetup: INFRA_GLOBAL_SETUP,
      setupFiles: [LEAK_WORKER],
      fileParallelism: false,
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
  {
    extends: true,
    test: {
      name: 'api',
      environment: 'node',
      include: ['tests/api/**/*.test.ts'],
      globalSetup: INFRA_GLOBAL_SETUP,
      setupFiles: [LEAK_WORKER],
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  },
  {
    extends: true,
    test: {
      name: 'security',
      environment: 'node',
      include: ['tests/security/**/*.test.ts'],
      globalSetup: INFRA_GLOBAL_SETUP,
      setupFiles: [LEAK_WORKER],
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  },
  {
    extends: true,
    test: {
      name: 'e2e',
      environment: 'node',
      include: ['tests/e2e/**/*.test.ts'],
      globalSetup: INFRA_GLOBAL_SETUP,
      setupFiles: [LEAK_WORKER],
      fileParallelism: false,
      testTimeout: 300_000,
      hookTimeout: 300_000,
    },
  },
  {
    extends: true,
    plugins: [react()],
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['apps/web/src/**/*.test.tsx'],
      setupFiles: ['apps/web/src/test/setup.ts'],
    },
  },
];

if (claudeLiveEnabled) {
  projects.push({
    extends: true,
    test: {
      name: 'claude-live',
      environment: 'node',
      include: ['tests/claude-live/**/*.test.ts'],
      // The opt-in guard runs first so a run without CLAUDE_LIVE=1 aborts before touching infrastructure.
      globalSetup: ['tests/setup/claude-live-guard.ts', ...INFRA_GLOBAL_SETUP],
      setupFiles: [LEAK_WORKER],
      fileParallelism: false,
      testTimeout: 900_000,
      hookTimeout: 300_000,
    },
  });
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    restoreMocks: true,
    unstubEnvs: true,
    projects,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', 'apps/web/src/test/**'],
    },
  },
});
