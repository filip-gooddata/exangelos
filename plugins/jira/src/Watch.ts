import { DateTime, Duration, Effect, Stream } from "effect"
import { Plugin } from "@exangelos/plugin-sdk"
import { decodeIssueCursor, decodeJqlCursor, encodeCursor, issuePosition } from "./Cursor.ts"
import { diffIssue, diffJql } from "./Diff.ts"
import { toItem } from "./Events.ts"
import type { WatchItem } from "./Events.ts"
import { defaultPollInterval } from "./JiraClient.ts"
import type { JiraClient } from "./JiraClient.ts"
import type { JiraSite } from "./Site.ts"
import type { Target } from "./Target.ts"

interface PollState {
  readonly cursor: string | undefined
  readonly wait: Duration.Duration | undefined
  readonly ended: boolean
}

interface Poll {
  readonly items: ReadonlyArray<WatchItem>
  readonly next: PollState
}

const read = (client: JiraClient["Service"], site: JiraSite, target: Target, cursor: string | undefined) =>
  Effect.gen(function*() {
    if (target.kind === "issue") {
      const previous = cursor === undefined ? undefined : yield* decodeIssueCursor(cursor)
      const snapshot = yield* client.readIssue({ site, key: target.key, position: issuePosition(previous) })
      return diffIssue({ siteUrl: site.url, previous, snapshot })
    }
    const previous = cursor === undefined ? undefined : yield* decodeJqlCursor(cursor)
    const snapshot = yield* client.readJql({ site, jql: target.jql })
    return diffJql({ siteUrl: site.url, previous, snapshot, observedAt: yield* DateTime.now })
  })

const ended = (cursor: string | undefined, reason: string): Poll => ({
  items: [Plugin.end(reason)],
  next: { cursor, wait: undefined, ended: true }
})

const subjectName = (target: Target) => target.kind === "issue" ? `issue ${target.key}` : "JQL query"

/**
 * One poll from `cursor`: the new events, then the cursor after them when it moved. The cursor
 * moves only once the whole read has paged to the end, since the client returns nothing before then.
 */
const poll = (client: JiraClient["Service"], site: JiraSite, target: Target, cursor: string | undefined) =>
  read(client, site, target, cursor).pipe(
    Effect.map(({ cursor: after, events }): Poll => {
      const next = encodeCursor(after)
      const items = events.map(toItem)
      return {
        items: next === cursor ? items : [...items, Plugin.cursor(next)],
        next: { cursor: next, wait: defaultPollInterval, ended: false }
      }
    }),
    Effect.catchTags({
      RateLimited: ({ retryAfterSeconds }) =>
        Effect.succeed<Poll>({
          items: [],
          next: {
            cursor,
            wait: retryAfterSeconds === undefined ? defaultPollInterval : Duration.seconds(retryAfterSeconds),
            ended: false
          }
        }).pipe(Effect.tap(Effect.logWarning("Jira is rate limiting this plugin; waiting before the next poll"))),
      NotFound: () => Effect.succeed(ended(cursor, `The ${subjectName(target)} no longer exists or this account cannot see it.`)),
      JqlResultTooLarge: ({ limit }) =>
        Effect.succeed(ended(cursor, `The JQL query matches more than ${limit} issues, the most one subscription tracks.`)),
      InvalidCursor: ({ reason }) =>
        Effect.succeed(ended(cursor, `${reason} Subscribe again to start from the issue's current state.`)),
      CredentialRejected: ({ status }) =>
        Effect.fail(new Plugin.CredentialsRejected({ reason: `Jira rejected the email and API token (HTTP ${status}).` })),
      UnsupportedSite: ({ reason }) => Effect.fail(new Plugin.SourceFailed({ reason })),
      HttpFailure: ({ reason, status }) =>
        Effect.fail(new Plugin.SourceFailed({ reason: status === undefined ? reason : `HTTP ${status}: ${reason}` })),
      DecodeFailure: ({ reason }) => Effect.fail(new Plugin.SourceFailed({ reason: `Unexpected Jira response: ${reason}` }))
    })
  )

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
    { cursor: input.cursor, wait: undefined, ended: false },
    (state) =>
      state.ended
        ? Effect.undefined
        : Effect.gen(function*() {
          if (state.wait !== undefined) yield* Effect.sleep(state.wait)
          const { items, next } = yield* poll(input.client, input.site, input.target, state.cursor)
          return [items, next] as const
        })
  ).pipe(Stream.flattenIterable)
