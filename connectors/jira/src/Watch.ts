import { DateTime, Duration, Effect, Stream } from "effect"
import type { Redacted } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { decodeIssueCursor, decodeJqlCursor, encodeCursor, issuePosition } from "./Cursor.ts"
import { toItem } from "./Events.ts"
import type { WatchItem } from "./Events.ts"
import { defaultPollInterval } from "./JiraClient.ts"
import type { JiraClient } from "./JiraClient.ts"
import type { InvalidCursor } from "./JiraError.ts"
import { diffIssue, diffJql, eventTypes } from "./Diff.ts"
import type { JiraEvent } from "./Diff.ts"
import type { GitHub, GitHubError } from "./GitHub.ts"
import { pollGitHub } from "./GitHubSignals.ts"
import type { GitHubPoll, IssueRef } from "./GitHubSignals.ts"
import type { Options } from "./Options.ts"
import { browseLink } from "./Site.ts"
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

interface Watched {
  readonly client: JiraClient["Service"]
  readonly github: GitHub["Service"]
  readonly site: JiraSite
  readonly target: Target
  readonly options: Options
  readonly githubToken: Redacted.Redacted<string> | undefined
}

type GitHubOutcome =
  | { readonly _tag: "Read"; readonly poll: GitHubPoll }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Unavailable"; readonly reason: string }

const githubOutcome = (repo: string, error: GitHubError): Effect.Effect<GitHubOutcome> => {
  switch (error._tag) {
    case "GitHubRejected":
      return Effect.succeed({
        _tag: "Unavailable",
        reason: `GitHub rejected githubToken (HTTP ${error.status}). Configure a token that can read ${repo}.`
      })
    case "GitHubNotFound":
      return Effect.succeed({ _tag: "Unavailable", reason: `GitHub has no ${error.path}, or githubToken cannot read it.` })
    case "GitHubRateLimited":
      return Effect.logWarning("GitHub is rate limiting githubToken; the GitHub signals wait for the next poll").pipe(
        Effect.as({ _tag: "Skipped" })
      )
    case "GitHubFailure":
      return Effect.logWarning(`GitHub signals skipped this poll: ${error.reason}`).pipe(Effect.as({ _tag: "Skipped" }))
  }
}

const unavailableEvent = (input: {
  readonly issue: IssueRef
  readonly repo: string
  readonly reason: string
  readonly episode: number
  readonly siteUrl: string
  readonly at: DateTime.Utc
}): JiraEvent => ({
  type: eventTypes.githubUnavailable,
  occurredAt: input.at,
  summary: `${input.issue.key}: GitHub signals for ${input.repo} stopped: ${input.reason}`,
  payload: { issue: input.issue, repo: input.repo, reason: input.reason },
  link: browseLink(input.siteUrl, input.issue.key),
  dedupeKey: `${input.issue.id}:github:unavailable:${input.episode}`
})

const read = (watched: Watched, site: JiraSite, cursor: string | undefined) =>
  Effect.gen(function*() {
    const { client, options, target } = watched
    if (target.kind === "issue") {
      const previous = cursor === undefined ? undefined : yield* decodeIssueCursor(cursor).pipe(Effect.catch(rebaseline))
      const snapshot = yield* client.readIssue({ site, key: target.key, position: issuePosition(previous) })
      const jira = diffIssue({ siteUrl: site.url, previous, snapshot, fields: options.fields, observedAt: yield* DateTime.now })
      const signals = options.github
      if (signals === undefined) {
        return { events: jira.events, cursor: { ...jira.cursor, github: null, githubFailure: null } }
      }
      const issue = { id: snapshot.id, key: snapshot.key, summary: snapshot.summary }
      const token = watched.githubToken
      const outcome = yield* (token === undefined
        ? Effect.succeed<GitHubOutcome>({ _tag: "Unavailable", reason: "No githubToken is configured for the jira connector." })
        : pollGitHub({
          github: watched.github,
          token,
          signals,
          issue,
          previous: jira.cursor.github,
          observedAt: yield* DateTime.now
        }).pipe(
          Effect.map((poll): GitHubOutcome => ({ _tag: "Read", poll })),
          Effect.catch((error) => githubOutcome(signals.repo, error))
        ))
      switch (outcome._tag) {
        case "Read":
          return {
            events: [...jira.events, ...outcome.poll.events],
            cursor: { ...jira.cursor, github: outcome.poll.cursor, githubFailure: null }
          }
        case "Skipped":
          return jira
        case "Unavailable": {
          if (jira.cursor.githubFailure !== null) return { ...jira, cursor: { ...jira.cursor, githubFailure: outcome.reason } }
          const episode = jira.cursor.githubFailures + 1
          return {
            events: [...jira.events, unavailableEvent({ issue, repo: signals.repo, reason: outcome.reason, episode, siteUrl: site.url, at: yield* DateTime.now })],
            cursor: { ...jira.cursor, githubFailure: outcome.reason, githubFailures: episode }
          }
        }
      }
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
      HttpFailure: ({ reason, status }) => {
        if (target.kind === "jql" && status === 400) {
          return Effect.succeed(ended(state, "Jira refused the JQL query (HTTP 400). Check the query and subscribe again."))
        }
        const failed = new Connector.SourceFailed({ reason: status === undefined ? reason : `HTTP ${status}: ${reason}` })
        if (status !== 403) return Effect.fail(failed)
        return client.resolveRoute(site).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.fail(failed),
            onFailure: (error) =>
              Effect.fail(
                error._tag === "CredentialRejected"
                  ? new Connector.CredentialsRejected({ reason: `Jira rejected the email and API token (HTTP ${error.status}).` })
                  : failed
              )
          })
        )
      },
      DecodeFailure: ({ reason }) => Effect.fail(new Connector.SourceFailed({ reason: `Unexpected Jira response: ${reason}` }))
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
