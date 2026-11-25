# Real Python ledger tests

`Reconcile.test.ts` and `Slack.test.ts` run the real Python ledger against a temporary `EXANGELOS_HOME`. Each test may start several Python processes in sequence. Their explicit 60-second test deadline allows for scheduler contention.

`LedgerProcess.ts` retains a 45-second deadline per process, below the overall test deadline. A hung first process therefore reaches its own deadline before the test deadline. If a later process outlives the remaining test budget, Vitest interrupts the Effect; the helper kills the child and waits for its close event before releasing the temporary home. Assertion failures and stream cancellation use the same Effect cleanup. Neither deadline is a retry or a performance guarantee under arbitrary host load.

Run `pnpm --filter @exangelos/connector-slack test`. For contention checks, repeat that command sequentially and record host load; use `pnpm --filter @exangelos/connector-slack --filter @exangelos/connector-teams test` for the adjacent connector boundary. These checks use fixtures only and need no live Slack account or cache.

On macOS, run `python3 connectors/shared/test_local_app_icon.py` from the repository root to exercise the icon renderer against generated app bundles.

For installed-archive acceptance, run `python3 -B connectors/slack/test/archive_validation.py /tmp/slack-archive-evidence` with Bun, jq and workspace dependencies installed. Choose a fresh, short directory path so the daemon socket fits the platform limit. The harness packs Slack, builds the CLI with the matching official catalogue and installs from that archive in a synthetic home. It checks the receiving command’s stdin, subscription counters, acknowledgement, one-shot completion and restart behavior alongside connector RPC replay. It also runs the documented pending-status pipeline against the daemon-installed ledger. The evidence directory retains the packer and daemon logs, archive checksum, captured stdin, pending reports and final result.
