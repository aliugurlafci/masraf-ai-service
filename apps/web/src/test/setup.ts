import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The first render of a test file pays module warm-up (zod schemas, router); under a parallel full
// run that can exceed the 1 s default of findBy*/waitFor.
configure({ asyncUtilTimeout: 5000 });
// user-event typing through full app renders is slow on loaded CI hosts.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
