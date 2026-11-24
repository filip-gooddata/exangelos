# Real Python ledger tests

The real-process cases in `Teams.test.ts` use a temporary `EXANGELOS_HOME` and may start several Python processes sequentially. Their explicit 60-second test budget accommodates scheduler contention. Two integration runs exceeded Vitest's default 5 seconds; their logs contain timeout errors, not assertion mismatches. Load is a plausible contributor, not a proven sole cause.

`LedgerProcess.ts` keeps its 45-second child deadline. On Effect interruption it kills the child and waits for close before the temporary home is removed. The production reconcile deadline remains 45 seconds; no assertions, polling behavior or runtime files change. Tests that only use synthetic process responses or acquisition failures keep the default budget.

Run `pnpm --filter @exangelos/connector-teams test` and `pnpm --filter @exangelos/connector-teams typecheck`. Any repeat should be sequential with recorded host load; no live Teams data is needed. These budgets are not a guarantee under arbitrary host load.

On macOS, run `python3 connectors/shared/test_local_app_icon.py` from the repository root to exercise the icon renderer against generated app bundles.
