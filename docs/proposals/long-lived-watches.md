# Long-lived watches

Status: proposal, not implemented.

## Problem

A pull request can stay open for weeks. Every subscription expires at most one lifetime (7 days by default) after it was created or last resumed, so a github-pr watch on a slow PR expires before the PR merges. The global defaults stay as they are: a 7-day lifetime and a 20-event backlog (`packages/domain/src/Limits.ts:16-18`). Most watches are short, and expiry is what cleans up watches that agents forget.

## How expiry works today

- `limits.lifetime` defaults to 7 days (`packages/domain/src/Limits.ts:18`). The user can change it for every watch with `exangelos settings set limits.lifetime="30 days"` (`apps/cli/src/commands/Management.ts:240-256`) or in the tray (`apps/tray/src/view/Model.ts:127`). A changed setting applies to later expiry calculations; stored `expiresAt` values stay as they are.
- Subscribe sets `expiresAt` to the earlier of `--until` and now plus the lifetime (`packages/domain/src/Lifecycle.ts:33-34`). A later `--until` is clamped, not rejected.
- `update --until` caps at the last create or resume plus the lifetime (`packages/domain/src/Subscribe.ts:101,107`, `packages/application/src/subscriptions/useCases/update.ts:43-54`). So `update` can shorten a watch but cannot extend it past that cap.
- `resume` accepts a Paused or Expired subscription and sets `expiresAt` to now plus the lifetime (`packages/domain/src/Lifecycle.ts:120-135`). Each resume gives another full lifetime. It is refused while the backlog is over its limit, so the agent may have to ack first (`packages/domain/src/Lifecycle.ts:129-131`).
- An Expired subscription stays resumable until retention cancels it, one retention period (30 days by default) after it entered Expired (`packages/domain/src/Limits.ts:21`, `packages/domain/src/Retention.ts:12-16`).
- The Expired wake prints a ready-made resume line. `WakeText.command` is the literal `"exangelos"` (`packages/contracts/src/WakeText.ts:4`), the resume row is built at line 45, and the Expired case adds it at lines 60-62. The wake shows `Resume  exangelos resume <id>`.

So a PR watch can already live for weeks if the agent resumes it on each Expired wake. The cost is one wake and one command per week per PR, and nothing is watched between the expiry and the resume.

## Options

**A. Per-subscription lifetime.** Add an optional `lifetime` to the subscription (`packages/domain/src/Subscription.ts:30-46`) and a `--lifetime <duration>` flag on `subscribe` and `update`. Create, update and resume use `subscription.lifetime ?? limits.lifetime`. A new limit, `limits.maxLifetime`, caps the requested value.

- Pros: the agent opts in per watch, at the place where it knows the watch is a PR. Other watches keep 7 days. The change stays in the domain, the application use cases, the CLI and the contracts; connectors are untouched. Old stored subscriptions decode unchanged because the field is optional.
- Cons: one new stored field, one new flag on two commands carried through the subscribe and update requests and use cases, one new limit.

**B. Per-connector lifetime in the manifest.** Add an optional `lifetime` to `connector.json` (`packages/contracts/src/Manifest.ts:22-33`). The application uses it in place of `limits.lifetime` for that connector's subscriptions, capped by `limits.maxLifetime`.

- Pros: no agent action. Every github-pr watch gets the longer life.
- Cons: the manifest field has to be carried through the connector directory adapter, which returns only name, version, directory, entry and digest today (`adapters/connector-directory/src/ConnectorDirectoryLive.ts:55-60`). Create and update already look the connector up (`packages/application/src/subscriptions/useCases/subscribe.ts:40`, `update.ts:37`), but that lookup would also have to return the manifest lifetime, and resume would need a lookup it doesn't do now. An imported third-party connector could ask for the maximum, so the cap is required. The connector author sets a policy that belongs to the user.

**C. Let `--until` pass the lifetime.** Drop the clamp when `--until` is given, up to `limits.maxLifetime`.

- Pros: the smallest code change: two `DateTime.min` calls.
- Cons: `resume` still resets to now plus 7 days and drops the requested end, so a resumed long watch becomes a short one again. Agents would need to compute an absolute date for "until merged", which they can't know.

**D. No change.** Agents resume on each Expired wake, as the wake already tells them to.

- Pros: nothing to build.
- Cons: a weekly gap in coverage and a weekly wake per long PR.

## Recommendation

Option A, with `limits.maxLifetime` defaulting to 90 days. It keeps the 7-day default for every existing watch and puts the choice with the agent that knows what it is watching. The github-pr skill or docs can tell agents to pass `--lifetime "30 days"` for PR watches.

Decisions needed: the `maxLifetime` default (90 days proposed), and whether the duration format for `--lifetime` reuses the settings form, such as "30 days".
