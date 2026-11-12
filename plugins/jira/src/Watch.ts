import { DateTime, Duration, Effect, Stream } from "effect"
import { Plugin } from "@exangelos/plugin-sdk"
import { decodeIssueCursor, decodeJqlCursor, encodeCursor, issuePosition } from "./Cursor.ts"
import { diffIssue, diffJql } from "./Diff.ts"
import { toItem } from "./Events.ts"
import type { WatchItem } from "./Events.ts"
import { defaultPollInterval } from "./JiraClient.ts"
import type { JiraClient } from "./JiraClient.ts"
import type { InvalidCursor } from "./JiraError.ts"
import type { JiraSite } from "./Site.ts"
import type { Target } from "./Target.ts"

interface PollState {
  /** The site with the route that accepted the credential; undefined until the first poll resolves it. */
  readonly route: JiraSite | undefined
  readonly cursor: string | undefined
  readonly wait: Duration.Duration | undefined
  readonly ended: boolean
}

interface Poll {
  readonly items: ReadonlyArray<WatchItem>
  readonly next: PollState
}

/** A cursor this version cannot read is replaced by a baseline: no events, the cursor at the current state. */
const rebaseline = ({ reason }: InvalidCursor) =>
  Effect.logWarning(`${reason} Starting again from the current state.`).pipe(Effect.as(undefined))

const read = (client: JiraClient["Service"], site: JiraSite, target: Target, cursor: string | undefined) =>
  Effect.gen(function*() {
    if (target.kind === "issue") {
      const previous = cursor === undefined ? undefined : yield* decodeIssueCursor(cursor).pipe(Effect.catch(rebaseline))
      const snapshot = yield* client.readIssue({ site, key: target.key, position: issuePosition(previous) })
      return diffIssue({ siteUrl: site.url, previous, snapshot })
    }
    const previous = cursor === undefined ? undefined : yield* decodeJqlCursor(cursor).pipe(Effect.catch(rebaseline))
    const snapshot = yield* client.readJql({ site, jql: target.jql })
    return diffJql({ siteUrl: site.url, previous, snapshot, observedAt: yield* DateTime.now })
  })

const ended = (state: PollState, reason: string): Poll => ({
  items: [Plugin.end(reason)],
  next: { ...state, wait: undefined, ended: true }
})

const subjectName = (target: Target) => target.kind === "issue" ? `issue ${target.key}` : "JQL query"

/**
 * One poll from the state's cursor: the new events, then the cursor after them when it moved. The
 * cursor moves only once the whole read has paged to the end, since the client returns nothing
 * before then. The first poll resolves the route; a 401 on a resolved route resolves it once more,
 * in case the token was swapped for one that takes the other route.
 */
const poll = (client: JiraClient["Service"], site: JiraSite, target: Target, state: PollState) => {
  const { cursor } = state
  const attempt = (route: JiraSite) =>
    read(client, route, target, cursor).pipe(Effect.map((result) => ({ route, ...result })))
  const resolved = client.resolveRoute(site).pipe(Effect.flatMap(attempt))
  const routed = state.route === undefined
    ? resolved
    : attempt(state.route).pipe(Effect.catchTag("CredentialRejected", () => resolved))
  return routed.pipe(
    Effect.map(({ cursor: after, events, route }): Poll => {
      const next = encodeCursor(after)
      const items = events.map(toItem)
      return {
        items: next === cursor ? items : [...items, Plugin.cursor(next)],
        next: { route, cursor: next, wait: defaultPollInterval, ended: false }
      }
    }),
    Effect.catchTags({
      RateLimited: ({ retryAfterSeconds }) =>
        Effect.succeed<Poll>({
          items: [],
          next: {
            ...state,
            wait: retryAfterSeconds === undefined ? defaultPollInterval : Duration.seconds(retryAfterSeconds),
          }
        }).pipe(Effect.tap(Effect.logWarning("Jira is rate limiting this plugin; waiting before the next poll"))),
      NotFound: () => Effect.succeed(ended(state, `The ${subjectName(target)} no longer exists or this account cannot see it.`)),
      JqlResultTooLarge: ({ limit }) =>
        Effect.succeed(ended(state, `The JQL query matches more than ${limit} issues, the most one subscription tracks.`)),
      CredentialRejected: ({ status }) =>
        Effect.fail(new Plugin.CredentialsRejected({ reason: `Jira rejected the email and API token (HTTP ${status}).` })),
      UnsupportedSite: ({ reason }) => Effect.fail(new Plugin.SourceFailed({ reason })),
      HttpFailure: ({ reason, status }) =>
        Effect.fail(new Plugin.SourceFailed({ reason: status === undefined ? reason : `HTTP ${status}: ${reason}` })),
      DecodeFailure: ({ reason }) => Effect.fail(new Plugin.SourceFailed({ reason: `Unexpected Jira response: ${reason}` }))
    })
  )
}

/**
 * Polls the target until it ends: the first poll at once, then one every `defaultPollInterval`,
 * or after Retry-After when Jira rate limits.
 */
export const watch = (input: {
  readonly client: JiraClient["Service"]
  readonly site: JiraSite
  readonly target: Target
  readonly cursor: string | undefined
}) =>
  Stream.unfold<PollState, ReadonlyArray<WatchItem>, Plugin.CredentialsRejected | Plugin.SourceFailed, never>(
    { route: undefined, cursor: input.cursor, wait: undefined, ended: false },
    (state) =>
      state.ended
        ? Effect.undefined
        : Effect.gen(function*() {
          if (state.wait !== undefined) yield* Effect.sleep(state.wait)
          const { items, next } = yield* poll(input.client, input.site, input.target, state)
          return [items, next] as const
        })
  ).pipe(Stream.flattenIterable)
