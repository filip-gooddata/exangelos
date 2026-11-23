# Validate the Slack connector

Run these checks from the repository root:

```sh
pnpm --filter @exangelos/connector-slack typecheck
pnpm --filter @exangelos/connector-slack test
python3 -B -m unittest discover -s connectors/slack/direct -p 'test_*.py'
python3 -B connectors/slack/test/archive_validation.py <new-evidence-directory>
```

The Python fixtures encode synthetic Slack snapshots into the IndexedDB format.
SDK tests exercise consent, normalized parameters, private ledger replay and
cancellation. The archive check builds the public release, verifies its checksum
and exercises its bundled entry point in an isolated home. It sends synthetic
SDK events through the host wake renderer and T3 adapter, capturing the command's
standard input for assertions. CLI end-to-end tests
cover positional arguments, MCP parameters and installer protection for legacy
private state. Keep generated evidence outside the checkout.

To verify a release upgrade, supply two CLI builds and their matching official
Slack archives. The check configures previews through the older CLI, starts
the newer daemon in the same disposable home, and checks the refreshed
connector's stored event and delivered wake on the original subscription. Run
with both `--previews enabled` and `--previews disabled` to exercise the
persisted choices.

```sh
python3 -B connectors/slack/test/refresh_validation.py --members OLD_CLI OLD_ARCHIVE NEW_CLI NEW_ARCHIVE
```

These tests establish behavior for persisted snapshots. Staleness is unbounded,
and intermediate events can be missed. See the [source evidence](direct/evidence.md).
