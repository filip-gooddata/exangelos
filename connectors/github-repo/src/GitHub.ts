import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { Transport } from "@exangelos/connector-github-pr"
import type { Filters } from "./Diff.ts"
import type { Repository } from "./Repository.ts"
import type { Release, Run, Snapshot } from "./Snapshot.ts"

export type Connection = Transport.Connection
export type GitHubError = Transport.GitHubError
export type Quota = Transport.Quota

export class TooManyRefs extends Schema.TaggedError<TooManyRefs>()("TooManyRefs", { reason: Schema.String }) {}

export type SnapshotError = GitHubError | Transport.Forbidden | TooManyRefs

/** The most pages of 100 refs one listing may read in a poll. */
export const maxRefPages = 10

const releaseWindow = 20

const runWindow = 20

const RefConnection = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(Schema.Struct({
    name: Schema.String,
    target: Schema.NullOr(Schema.Struct({
      oid: Schema.String,
      target: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String })))
    }))
  }))
})

const ReleaseNode = Schema.Struct({
  databaseId: Schema.Finite,
  tagName: Schema.String,
  name: Schema.NullOr(Schema.String),
  url: Schema.String,
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
  publishedAt: Schema.NullOr(Schema.String)
})

const RunsBody = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({
    id: Schema.Finite,
    run_attempt: Schema.optionalKey(Schema.Finite),
    run_number: Schema.Finite,
    name: Schema.NullOr(Schema.String),
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    head_branch: Schema.NullOr(Schema.String),
    head_sha: Schema.String,
    event: Schema.String,
    html_url: Schema.String,
    updated_at: Schema.String
  }))
})

const refsFields = `pageInfo { hasNextPage endCursor }
      nodes { name target { oid ... on Tag { target { oid } } } }`

/** One listing of refs: a kind and the literal text GitHub narrows the names by. */
export interface Listing {
  readonly alias: string
  readonly kind: "tags" | "branches"
  readonly query: string
}

const prefixes = { tags: "refs/tags/", branches: "refs/heads/" } as const

export const listings = (filters: Filters): ReadonlyArray<Listing> => {
  const out: Array<Listing> = []
  for (const kind of ["tags", "branches"] as const) {
    const queries = [...new Set(filters[kind].map((glob) => glob.prefix))]
    const chosen = queries.includes("") ? [""] : queries
    chosen.forEach((query, i) => out.push({ alias: `${kind === "tags" ? "t" : "b"}${i}`, kind, query }))
  }
  return out
}

export const snapshotQuery = (all: ReadonlyArray<Listing>, releases: boolean) => {
  const variables = all.map((l) => `, $${l.alias}: String`).join("")
  const parts = all.map((l) =>
    `${l.alias}: refs(refPrefix: "${prefixes[l.kind]}", query: $${l.alias}, first: 100) {
      ${refsFields}
    }`
  )
  if (releases) {
    parts.push(`releases(first: ${releaseWindow}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { databaseId tagName name url isDraft isPrerelease publishedAt }
    }`)
  }
  return `query Snapshot($owner: String!, $name: String!${variables}) {
  repository(owner: $owner, name: $name) {
    ${parts.join("\n    ")}
  }
}`
}

export const refsPageQuery = `query RefsPage($owner: String!, $name: String!, $prefix: String!, $query: String, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: $prefix, query: $query, first: 100, after: $after) {
      ${refsFields}
    }
  }
}`

const viewerQuery = "query Viewer { viewer { login } }"

const Viewer = Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) })
const SnapshotData = Schema.Struct({
  repository: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
})
const RefsPageData = Schema.Struct({
  repository: Schema.NullOr(Schema.Struct({ refs: Schema.NullOr(RefConnection) }))
})
const Releases = Schema.Struct({ nodes: Schema.Array(ReleaseNode) })

/** ETags of the last run lists, by workflow. */
export type Etags = ReadonlyMap<string, string>

export interface Fetched {
  readonly snapshot: Snapshot
  readonly etags: Etags
  readonly quota: Option.Option<Quota>
}

const lower = (a: Option.Option<Quota>, b: Option.Option<Quota>) =>
  Option.isNone(a) ? b : Option.isNone(b) ? a : b.value.remaining < a.value.remaining ? b : a

export class GitHub extends Context.Service<GitHub, {
  /** Checks the token by asking who it belongs to. */
  readonly viewer: (connection: Connection) => Effect.Effect<string, GitHubError>
  readonly snapshot: (
    connection: Connection,
    repository: Repository,
    filters: Filters,
    etags: Etags
  ) => Effect.Effect<Fetched, SnapshotError>
}>()("@exangelos/connector-github-repo/GitHub") {}

export const layer = Layer.effect(
  GitHub,
  Effect.gen(function*() {
    const transport = Transport.make(yield* HttpClient.HttpClient, "exangelos-github-repo")
    const unreadable = () => new Transport.Unavailable({ reason: "GitHub sent an answer this connector cannot read" })

    const viewer = (connection: Connection) =>
      transport.graphql(connection, Viewer, viewerQuery, {}).pipe(Effect.map(({ data }) => data.viewer.login))

    const snapshot = (connection: Connection, repository: Repository, filters: Filters, etags: Etags) =>
      Effect.gen(function*() {
        const repo = `${repository.owner}/${repository.name}`
        const missing = new Transport.NotFound({ reason: `No repository ${repo}` })
        const all = listings(filters)
        const wantReleases = filters.releases.length > 0
        let quota = Option.none<Quota>()
        const tags = filters.tags.length > 0 ? new Map<string, string>() : null
        const branches = filters.branches.length > 0 ? new Map<string, string>() : null
        let releases: ReadonlyArray<Release> | null = null

        const take = (kind: "tags" | "branches", page: typeof RefConnection.Type) => {
          const into = kind === "tags" ? tags : branches
          for (const node of page.nodes) {
            if (node.target !== null && into !== null) into.set(node.name, node.target.target?.oid ?? node.target.oid)
          }
        }

        if (all.length > 0 || wantReleases) {
          const variables: Record<string, unknown> = { owner: repository.owner, name: repository.name }
          for (const l of all) variables[l.alias] = l.query === "" ? null : l.query
          const first = yield* transport.graphql(connection, SnapshotData, snapshotQuery(all, wantReleases), variables)
          quota = first.quota
          const data = first.data.repository
          if (data === null) return yield* missing
          for (const l of all) {
            let page = yield* Schema.decodeUnknownEffect(RefConnection)(data[l.alias]).pipe(Effect.mapError(unreadable))
            take(l.kind, page)
            for (let pages = 1; page.pageInfo.hasNextPage; pages++) {
              if (pages >= maxRefPages) {
                return yield* new TooManyRefs({
                  reason: `More than ${maxRefPages * 100} ${l.kind} of ${repo} match "${l.query}"; ` +
                    "give a pattern with a longer literal start"
                })
              }
              const more = yield* transport.graphql(connection, RefsPageData, refsPageQuery, {
                owner: repository.owner,
                name: repository.name,
                prefix: prefixes[l.kind],
                query: l.query === "" ? null : l.query,
                after: page.pageInfo.endCursor
              })
              quota = lower(quota, more.quota)
              const next = more.data.repository?.refs
              if (next == null) return yield* missing
              page = next
              take(l.kind, page)
            }
          }
          if (wantReleases) {
            const listed = yield* Schema.decodeUnknownEffect(Releases)(data["releases"]).pipe(Effect.mapError(unreadable))
            releases = listed.nodes.map((r) => ({
              id: r.databaseId,
              tag: r.tagName,
              name: r.name,
              prerelease: r.isPrerelease,
              draft: r.isDraft,
              publishedAt: r.publishedAt,
              url: r.url
            }))
          }
        }

        const workflows = new Map<string, ReadonlyArray<Run> | null>()
        const nextEtags = new Map<string, string>()
        for (const workflow of filters.workflows) {
          const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}` +
            `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${runWindow}`
          const answered = yield* transport.rest(connection, RunsBody, path, etags.get(workflow) ?? null).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.fail(new Transport.NotFound({ reason: `No workflow ${workflow} in ${repo}, or the token cannot see it` })))
          )
          quota = lower(quota, answered.quota)
          if (answered.etag !== null) nextEtags.set(workflow, answered.etag)
          workflows.set(workflow, answered.data === null ? null : answered.data.workflow_runs.map((run) => ({
            id: run.id,
            attempt: run.run_attempt ?? 1,
            runNumber: run.run_number,
            name: run.name ?? workflow,
            completed: run.status === "completed",
            conclusion: run.conclusion,
            branch: run.head_branch,
            sha: run.head_sha,
            event: run.event,
            url: run.html_url,
            updatedAt: run.updated_at
          })))
        }

        const result: Snapshot = { tags, branches, releases, workflows }
        return { snapshot: result, etags: nextEtags, quota }
      })

    return { viewer, snapshot }
  })
)
