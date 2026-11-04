# orphan-tests fixture

Repository whose test command (`node run-tests.mjs`) starts a detached (POSIX) grandchild and then never
finishes. Used by `tests/integration/worker/{cancel,timeout}-orphans.test.ts` to prove that cancelling or
timing out the testing stage leaves no process behind (contract §18.5). The command prints
`ORC_ORPHAN_TEST_PID=<pid>` and `ORC_ORPHAN_GRANDCHILD_PID=<pid>`; there is no JUnit report.
