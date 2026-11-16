# Real Python ledger tests

`Reconcile.test.ts` and `Slack.test.ts` run the real Python ledger against a temporary `EXANGELOS_HOME`. Each test may start several Python processes in sequence. Their explicit 60-second test deadline allows for scheduler contention.

`LedgerProcess.ts` retains a 45-second deadline per process, below the overall test deadline. A hung first process therefore reaches its own deadline before the test deadline. If a later process outlives the remaining test budget, Vitest interrupts the Effect; the helper kills the child and waits for its close event before releasing the temporary home. Assertion failures and stream cancellation use the same Effect cleanup. Neither deadline is a retry or a performance guarantee under arbitrary host load.

Run `pnpm --filter @exangelos/connector-slack test`. For contention checks, repeat that command sequentially and record host load; use `pnpm --filter @exangelos/connector-slack --filter @exangelos/connector-teams test` for the adjacent connector boundary. These checks use fixtures only and need no live Slack account or cache.
