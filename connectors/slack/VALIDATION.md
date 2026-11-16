# Validation

Publication validation uses synthetic inputs only. Historical machine-specific and account-derived observations are omitted.

Run `pnpm --filter @exangelos/connector-slack test` and `pnpm --filter @exangelos/connector-slack typecheck`. Python fixtures are in `direct/test_*.py`.

For the installed release contract, run `python3 connectors/slack/test/archive_validation.py <new-evidence-directory>` from the repository root. The harness overlays committed Slack files onto its pinned packer revision and uses an isolated synthetic home. It checks archive closure, startup without Python/app/configuration, deferred source access, immutable installation, configuration, reconciliation and durable replay. Keep generated evidence outside tracked publication content.

These commands describe verification; they are not claims about a particular execution.

## Portable configuration acceptance

`direct/test_setup.py` uses synthetic home directories, different persisted accounts,
standard and sandbox layouts, a renamed home, and explicit custom roots. It verifies
captured selection/key/scope, ambiguous roots/accounts, missing consent, stale pinned
accounts, deliberate reset, private file permissions, and the installed-path guard.
`test/Setup.test.ts` checks the Configure-only discovery boundary and exact resolved
request. `test/archive_validation.py` additionally exercises the unpacked release's new
setup fields, private pin, concrete changed-message event and exact replay after restart
under two distinct fixture users, retaining startup/immutability acceptance.

No live Slack data is used by these checks. Current sign-in authority is not claimed or
tested: the configuration explicitly authorizes persisted-cache discovery/use. The
original delayed-snapshot and missed-intermediate-event limitations remain unchanged.
