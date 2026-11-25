import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Redacted } from "effect"
import type { GitHubCursor } from "../src/Cursor.ts"
import { GitHubNotFound } from "../src/GitHub.ts"
import type { Commit, GitHub, PullRequest, Release } from "../src/GitHub.ts"
import { pollGitHub } from "../src/GitHubSignals.ts"
import type { GitHubSignals } from "../src/Options.ts"

const issue = { id: "10042", key: "DEMO-7", summary: "Fix login" }
const observedAt = DateTime.makeUnsafe("2026-11-20T10:00:00Z")
const signals: GitHubSignals = {
  repo: "acme/app",
  search: "DEMO-7",
  paths: ["src/login.ts"],
  since: undefined,
  sha: "abc1234"
}

const pr = (number: number, state: PullRequest["state"], updatedAt = "2026-11-20T09:00:00Z"): PullRequest => ({
  number,
  title: `DEMO-7 change ${number}`,
  state,
  url: `https://github.com/acme/app/pull/${number}`,
  author: "ana",
  updatedAt
})

const commit = (sha: string): Commit => ({
  sha,
  message: `Touch login ${sha}`,
  url: `https://github.com/acme/app/commit/${sha}`,
  author: "mia",
  date: "2026-11-20T09:30:00Z"
})

const release = (tag: string): Release => ({ tag, url: `https://github.com/acme/app/releases/tag/${tag}`, publishedAt: null })

/** A GitHub whose answers the test changes between polls, and which counts what it was asked. */
const fakeGitHub = (state: {
  pullRequests: ReadonlyArray<PullRequest>
  commits: ReadonlyArray<Commit>
  releases: ReadonlyArray<Release>
  containing: ReadonlyArray<string>
  missingTags?: ReadonlyArray<string>
  shaGone?: boolean
}) => {
  const asked = { releases: 0, compared: [] as Array<string>, since: [] as Array<string> }
  const github: GitHub["Service"] = {
    checkRepository: () => Effect.void,
    checkCommit: (_token, _repo, sha) =>
      state.shaGone === true ? Effect.fail(new GitHubNotFound({ path: `/repos/acme/app/commits/${sha}` })) : Effect.void,
    searchPullRequests: () => Effect.sync(() => state.pullRequests),
    commits: (_token, _repo, _path, since) => Effect.sync(() => (asked.since.push(since), state.commits)),
    releases: () => Effect.sync(() => (asked.releases += 1, state.releases)),
    contains: (_token, _repo, _sha, tag) =>
      Effect.suspend(() => {
        asked.compared.push(tag)
        return state.missingTags?.includes(tag)
          ? Effect.fail(new GitHubNotFound({ path: `/compare/${tag}` }))
          : Effect.succeed(state.containing.includes(tag))
      })
  }
  return { github, asked }
}

const poll = (github: GitHub["Service"], previous: GitHubCursor | null, with_: Partial<GitHubSignals> = {}) =>
  pollGitHub({
    github,
    token: Redacted.make("ghp-not-a-real-token"),
    signals: { ...signals, ...with_ },
    issue,
    previous,
    observedAt
  })

describe("GitHub signals", () => {
  it.effect("baselines pull requests and commits, then reports what appears or changes after", () =>
    Effect.gen(function*() {
      const state = {
        pullRequests: [pr(5, "open")],
        commits: [commit("c1")],
        releases: [release("v1.0.0")],
        containing: [] as Array<string>
      }
      const { asked, github } = fakeGitHub(state)
      const first = yield* poll(github, null)
      expect(first.events).toEqual([])
      expect(first.cursor.since).toBe("2026-11-20T10:00:00.000Z")

      state.pullRequests = [pr(5, "merged", "2026-11-20T09:40:00Z"), pr(6, "open")]
      state.commits = [commit("c2"), commit("c1")]
      const second = yield* poll(github, first.cursor)
      expect(second.events.map((event) => [event.type, event.dedupeKey])).toEqual([
        ["pull_request.state_changed", "10042:github:acme/app#5:merged:2026-11-20T09:40:00Z"],
        ["pull_request.found", "10042:github:acme/app#6:found"],
        ["commit.added", "10042:github:acme/app:commit:c2"]
      ])
      expect(second.events[0]?.summary).toBe("DEMO-7: acme/app#5 open → merged: DEMO-7 change 5")
      expect(second.events[0]?.payload).toMatchObject({ from: "open", state: "merged", number: 5 })
      expect(asked.since).toEqual(["2026-11-20T10:00:00.000Z", "2026-11-20T10:00:00.000Z"])

      const third = yield* poll(github, second.cursor)
      expect(third.events).toEqual([])
    }))

  it.effect("reports the release that contains the commit on the first poll, once", () =>
    Effect.gen(function*() {
      const { asked, github } = fakeGitHub({
        pullRequests: [],
        commits: [],
        releases: [release("v1.1.0"), release("v1.0.0")],
        containing: ["v1.1.0", "v1.0.0"]
      })
      const first = yield* poll(github, null, { paths: [] })
      expect(first.events.map((event) => [event.type, event.summary, event.link])).toEqual([
        ["release.found", "DEMO-7: release v1.1.0 of acme/app contains abc1234", "https://github.com/acme/app/releases/tag/v1.1.0"]
      ])
      const second = yield* poll(github, first.cursor, { paths: [] })
      expect(second.events).toEqual([])
      expect(asked.releases).toBe(1)
    }))

  it.effect("compares every listed release on each poll, so a missing or moved tag is seen later", () =>
    Effect.gen(function*() {
      const state = {
        pullRequests: [],
        commits: [],
        releases: [release("v2.0.0-draft"), release("v1.0.0")],
        containing: [] as Array<string>,
        missingTags: ["v2.0.0-draft"]
      }
      const { asked, github } = fakeGitHub(state)
      const first = yield* poll(github, null, { paths: [] })
      expect(first.cursor.release).toEqual({ sha: "abc1234", tag: null })

      state.missingTags = []
      state.containing = ["v1.0.0"]
      const second = yield* poll(github, first.cursor, { paths: [] })
      expect(second.events.map((event) => [event.type, event.payload])).toEqual([
        ["release.found", expect.objectContaining({ tag: "v1.0.0" })]
      ])
      expect(asked.compared).toEqual(["v2.0.0-draft", "v1.0.0", "v2.0.0-draft", "v1.0.0"])
    }))

  it.effect("fails with the missing commit when sha is gone from the repository", () =>
    Effect.gen(function*() {
      const { github } = fakeGitHub({
        pullRequests: [],
        commits: [],
        releases: [release("v1.0.0")],
        containing: [],
        missingTags: ["v1.0.0"],
        shaGone: true
      })
      const failure = yield* poll(github, null, { paths: [] }).pipe(Effect.flip)
      expect(failure).toEqual(new GitHubNotFound({ path: "/repos/acme/app/commits/abc1234" }))
      const unreleased = fakeGitHub({ pullRequests: [], commits: [], releases: [], containing: [], shaGone: true })
      expect(yield* poll(unreleased.github, null, { paths: [] }).pipe(Effect.flip)).toEqual(failure)
    }))

  it.effect("starts pull requests from a new baseline when the search changes", () =>
    Effect.gen(function*() {
      const state = { pullRequests: [pr(5, "open")], commits: [], releases: [], containing: [] }
      const { github } = fakeGitHub(state)
      const first = yield* poll(github, null, { paths: [], sha: undefined })
      state.pullRequests = [pr(5, "open"), pr(9, "open")]
      const second = yield* poll(github, first.cursor, { paths: [], sha: undefined, search: "login" })
      expect(second.events).toEqual([])
      expect(second.cursor.search).toBe("login")
    }))

  it.effect("reports a new commit once, with every watched path it touched", () =>
    Effect.gen(function*() {
      const state = { pullRequests: [], commits: [commit("c1")], releases: [], containing: [] }
      const { github } = fakeGitHub(state)
      const paths = ["src/login.ts", "src/auth.ts"]
      const first = yield* poll(github, null, { paths, sha: undefined })
      state.commits = [commit("c2"), commit("c1")]
      const second = yield* poll(github, first.cursor, { paths, sha: undefined })
      expect(second.events.map((event) => [event.dedupeKey, event.payload])).toEqual([
        ["10042:github:acme/app:commit:c2", expect.objectContaining({ paths: ["src/login.ts", "src/auth.ts"], sha: "c2" })]
      ])
    }))
})
