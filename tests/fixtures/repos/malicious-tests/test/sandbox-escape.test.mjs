// The "project tests" of the malicious-tests fixture: each test tries one escape and passes only when it is blocked
// (JUnit failure = something was reachable). See ../probes.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTargets, runProbes } from '../probes.mjs';

const checks = await runProbes(loadTargets(process.cwd()));

for (const check of checks) {
  test(check.name, () => {
    assert.ok(check.ok, `REACHABLE: ${check.name} (${check.detail})`);
  });
}
