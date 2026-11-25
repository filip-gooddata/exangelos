import { DateTime, Duration, Effect, Stream } from "effect"
import type { Redacted } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { decodeIssueCursor, decodeJqlCursor, encodeCursor, issuePosition } from "./Cursor.ts"
import { diffIssue, diffJql } from "./Diff.ts"
import { toItem } from "./Events.ts"
import type { WatchItem } from "./Events.ts"
import { defaultPollInterval } from "./JiraClient.ts"
import type { JiraClient } from "./JiraClient.ts"
import type { InvalidCursor } from "./JiraError.ts"
import type { GitHub } from "./GitHub.ts"
import { pollGitHub } from "./GitHubSignals.ts"
import type { Options } from "./Options.ts"
import type { JiraSite } from "./Site.ts"
import type { Target } from "./Target.ts"

interface PollState {
  /** The site with the route that accepted the credential; undefined until the first poll resolves it. */
  readonly route: JiraSite | undefined
  readonly cursor: string | undefined
  readonly wait: Duration.Duration | undefined
  readonly ended: boolean
  /** Whether this run already re-resolved the route after a 401; the next 401 ends it. */
  readonly recovered: boolean
}

interface Poll {
  readonly items: ReadonlyArray<WatchItem>
  readonly next: PollState
}

/** A cursor this version cannot read is replaced by a baseline: no events, the cursor at the current state. */
const rebaseline = ({ reason }: InvalidCursor) =>
  Effect.logWarning(`${reason} Starting again from the current state.`).pipe(Effect.as(undefined))

/** Everything one subscription's polls read with. */
interface Watched {
  readonly client: JiraClient["Service"]
  readonly github: GitHub["Service"]
  readonly site: JiraSite
  readonly target: Target
  readonly options: Options
  /** The configured GitHub token; the connector refuses GitHub signals without one. */
  readonly githubToken: Redacted.Redacted<string> | undefined
}

const githubRateLimited = Effect.logWarning(
  "GitHub is rate limiting this connector; the GitHub signals wait for the next poll"
).pipe(Effect.as(undefined))

const read = (watched: Watched, site: JiraSite, cursor: string | undefined) =>
  Effect.gen(function*() {
    const { client, options, target } = watched
    if (target.kind === "issue") {
      const previous = cursor === undefined ? undefined : yield* decodeIssueCursor(cursor).pipe(Effect.catch(rebaseline))
      const snapshot = yield* client.readIssue({ site, key: target.key, position: issuePosition(previous) })
      const jira = diffIssue({ siteUrl: site.url, previous, snapshot, fields: options.fields })
      const signals = options.github
      if (signals === undefined || watched.githubToken === undefined) {
        return { events: jira.events, cursor: { ...jira.cursor, github: null } }
      }
      const github = yield* pollGitHub({
        github: watched.github,
        token: watched.githubToken,
        signals,
        issue: { id: snapshot.id, key: snapshot.key, summary: snapshot.summary },
        previous: jira.cursor.github,
        observedAt: yield* DateTime.now
      }).pipe(Effect.catchTag("GitHubRateLimited", () => githubRateLimited))
      if (github === undefined) return jira
      return { events: [...jira.events, ...github.events], cursor: { ...jira.cursor, github: github.cursor } }
    }
    const previous = cursor === undefined ? undefined : yield* decodeJqlCursor(cursor).pipe(Effect.catch(rebaseline))
    const snapshot = yield* client.readJql({ site, jql: target.jql })
    return diffJql({ siteUrl: site.url, previous, snapshot, observedAt: yield* DateTime.now })
  })

const ended = (state: PollState, reason: string): Poll => ({
  items: [Connector.end(reason)],
  next: { ...state, wait: undefined, ended: true }
})

const subjectName = (target: Target) => target.kind === "issue" ? `issue ${target.key}` : "JQL query"

/**
 * One poll from the state's cursor: the new events, then the cursor after them when it moved. The
 * cursor moves only once the whole read has paged to the end, since the client returns nothing
 * before then. The first poll resolves the route; the first 401 on a resolved route resolves it
 * once more, in case the token was swapped for one that takes the other route. Any later 401 in
 * the same run ends it.
 */
const poll = (watched: Watched, state: PollState) => {
  const { client, site, target } = watched
  const { cursor } = state
  /** Route and recovery as this poll leaves them, kept by every outcome that does not end the run. */
  let reached: Pick<PollState, "route" | "recovered"> = { route: state.route, recovered: state.recovered }
  const attempt = (route: JiraSite) => read(watched, route, cursor)
  const resolved = client.resolveRoute(site).pipe(
    Effect.tap((route) => Effect.sync(() => (reached = { ...reached, route }))),
    Effect.flatMap(attempt)
  )
  const routed = state.route === undefined
    ? resolved
    : attempt(state.route).pipe(
      Effect.catchTag("CredentialRejected", (rejected) => {
        if (state.recovered) return Effect.fail(rejected)
        reached = { ...reached, recovered: true }
        return resolved
      })
    )
  return routed.pipe(
    Effect.map(({ cursor: after, events }): Poll => {
      const next = encodeCursor(after)
      const items = events.map(toItem)
      return {
        items: next === cursor ? items : [...items, Connector.cursor(next)],
        next: { ...reached, cursor: next, wait: defaultPollInterval, ended: false }
      }
    }),
    Effect.catchTags({
      RateLimited: ({ retryAfterSeconds }) =>
        Effect.succeed<Poll>({
          items: [],
          next: {
            ...state,
            ...reached,
            wait: retryAfterSeconds === undefined ? defaultPollInterval : Duration.seconds(retryAfterSeconds),
          }
        }).pipe(Effect.tap(Effect.logWarning("Jira is rate limiting this connector; waiting before the next poll"))),
      NotFound: () =>
        client.resolveRoute(site).pipe(
          Effect.as(ended(state, `The ${subjectName(target)} no longer exists or this account cannot see it.`)),
          Effect.catchTag("CredentialRejected", ({ status }) =>
            Effect.fail(
              new Connector.CredentialsRejected({ reason: `Jira rejected the email and API token (HTTP ${status}).` })
            )),
          Effect.mapError((error) =>
            error instanceof Connector.CredentialsRejected
              ? error
              : new Connector.SourceFailed({ reason: `Jira answered 404, then the credential check failed (${error._tag}).` })
          )
        ),
      JqlResultTooLarge: ({ limit }) =>
        Effect.succeed(ended(state, `The JQL query matches more than ${limit} issues, the most one subscription tracks.`)),
      CredentialRejected: ({ status }) =>
        Effect.fail(new Connector.CredentialsRejected({ reason: `Jira rejected the email and API token (HTTP ${status}).` })),
      UnsupportedSite: ({ reason }) => Effect.fail(new Connector.SourceFailed({ reason })),
      HttpFailure: ({ reason, status }) =>
        target.kind === "jql" && status === 400
          ? Effect.succeed(ended(state, "Jira refused the JQL query (HTTP 400). Check the query and subscribe again."))
          : Effect.fail(new Connector.SourceFailed({ reason: status === undefined ? reason : `HTTP ${status}: ${reason}` })),
      DecodeFailure: ({ reason }) => Effect.fail(new Connector.SourceFailed({ reason: `Unexpected Jira response: ${reason}` })),
      GitHubRejected: ({ status }) =>
        Effect.fail(
          new Connector.CredentialsRejected({
            reason: `GitHub rejected githubToken (HTTP ${status}). Configure a token that can read the repository.`
          })
        ),
      GitHubNotFound: ({ path }) =>
        Effect.fail(new Connector.SourceFailed({ reason: `GitHub has no ${path}, or githubToken cannot read it.` })),
      GitHubFailure: ({ reason }) => Effect.fail(new Connector.SourceFailed({ reason }))
    })
  )
}

/**
 * Polls the target until it ends: the first poll at once, then one every `defaultPollInterval`,
 * or after Retry-After when Jira rate limits.
 */
export const watch = (input: Watched & { readonly cursor: string | undefined }) =>
  Stream.unfold<PollState, ReadonlyArray<WatchItem>, Connector.CredentialsRejected | Connector.SourceFailed, never>(
    { route: undefined, cursor: input.cursor, wait: undefined, ended: false, recovered: false },
    (state) =>
      state.ended
        ? Effect.undefined
        : Effect.gen(function*() {
          if (state.wait !== undefined) yield* Effect.sleep(state.wait)
          const { items, next } = yield* poll(input, state)
          return [items, next] as const
        })
  ).pipe(Stream.flattenIterable)
