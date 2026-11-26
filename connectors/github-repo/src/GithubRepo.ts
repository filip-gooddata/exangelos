import { DateTime, Effect, Option, Redacted, Ref, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import type { Filters, Site } from "./Diff.ts"
import { descriptions, type Emitted, type EventType, payloads } from "./Events.ts"
import { type Connection, GitHub } from "./GitHub.ts"
import * as Glob from "./Glob.ts"
import * as Poll from "./Poll.ts"
import * as Repository from "./Repository.ts"

const declare = <K extends EventType>(type: K) =>
  Catalogue.event(type, { description: descriptions[type], payload: payloads[type] })

export const events = {
  "tag.created": declare("tag.created"),
  "tag.moved": declare("tag.moved"),
  "branch.created": declare("branch.created"),
  "branch.moved": declare("branch.moved"),
  "branch.deleted": declare("branch.deleted"),
  "release.published": declare("release.published"),
  "workflow.started": declare("workflow.started"),
  "workflow.completed": declare("workflow.completed")
}

/** A list, or from the command line one value or a JSON array in a string. */
const List = (description: string) =>
  Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String]).annotate({ description }))

const parameters = Catalogue.parameters({
  main: "repository",
  schema: Schema.Struct({
    repository: Schema.String,
    tags: List("Tag name patterns; * matches any run of characters, ? one character"),
    branches: List("Branch name patterns; * matches any run of characters, / included, ? one character"),
    releases: List("Tag name patterns of the releases release.published reports; * for every release"),
    workflows: List("Workflow file names or ids, such as release.yaml, whose runs to report")
  })
})

type Parameters = typeof parameters.schema.Type

/** A JSON array of strings, or undefined for anything else. */
const jsonList = (value: string): ReadonlyArray<string> | undefined => {
  if (!value.trim().startsWith("[")) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined
  } catch {
    return undefined
  }
}

const list = (value: ReadonlyArray<string> | string | undefined): ReadonlyArray<string> => {
  const items = value === undefined ? [] : typeof value === "string" ? jsonList(value) ?? [value] : value
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))]
}

const Workflow = /^[A-Za-z0-9._-]+$/

const read = (p: Parameters) =>
  Effect.gen(function*() {
    const repository = Repository.parse(p.repository)
    if (repository === undefined) {
      return yield* Effect.fail(`Expected a repository as owner/repo, got "${p.repository}"`)
    }
    const tags = list(p.tags)
    const branches = list(p.branches)
    const releases = list(p.releases)
    const workflows = list(p.workflows)
    if (tags.length + branches.length + releases.length + workflows.length === 0) {
      return yield* Effect.fail("Give at least one of tags, branches, releases or workflows")
    }
    const wrong = workflows.find((w) => !Workflow.test(w))
    if (wrong !== undefined) {
      return yield* Effect.fail(`Expected workflows to hold workflow file names or ids, got "${wrong}"`)
    }
    const filters: Filters = {
      tags: tags.map(Glob.compile),
      branches: branches.map(Glob.compile),
      releases: releases.map(Glob.compile),
      workflows
    }
    const normalised: Parameters = {
      repository: Repository.format(repository),
      ...(tags.length === 0 ? {} : { tags }),
      ...(branches.length === 0 ? {} : { branches }),
      ...(releases.length === 0 ? {} : { releases }),
      ...(workflows.length === 0 ? {} : { workflows })
    }
    return { repository, filters, normalised }
  })

const Host = /^[A-Za-z0-9.-]+(:[0-9]+)?$/

const toItem = (event: Emitted, cursor: string | undefined) =>
  (events[event.type] as Catalogue.EventType<typeof event.payload>).item({
    occurredAt: DateTime.makeUnsafe(event.occurredAt),
    summary: event.summary,
    payload: event.payload,
    dedupeKey: event.dedupeKey,
    ...(event.link === null ? {} : { link: event.link }),
    ...(cursor === undefined ? {} : { cursor })
  })

export const connector = Connector.make({
  events: [
    events["tag.created"],
    events["tag.moved"],
    events["branch.created"],
    events["branch.moved"],
    events["branch.deleted"],
    events["release.published"],
    events["workflow.started"],
    events["workflow.completed"]
  ],
  parameters,
  configuration: [
    Catalogue.secret("token", { label: "GitHub token" }),
    Catalogue.text("host", { label: "GitHub Enterprise host (empty for github.com)", required: false, secretDestination: true })
  ],
  handlers: Effect.gen(function*() {
    const github = yield* GitHub
    const configured = yield* Ref.make(Option.none<Connection>())
    return {
      configure: (values) =>
        Effect.gen(function*() {
          const host = (values.host ?? "").trim() || "github.com"
          if (!Host.test(host)) {
            return yield* new Connector.ConfigurationRejected({ reason: `Expected a host name such as github.acme.dev, got "${host}"` })
          }
          const connection: Connection = { host, token: Redacted.make(values.token ?? "") }
          yield* github.viewer(connection).pipe(
            Effect.catchTags({
              Unauthorized: ({ reason }) => Effect.fail(new Connector.ConfigurationRejected({ reason })),
              NotFound: () => Effect.void,
              RateLimited: () => Effect.void,
              Unavailable: () => Effect.void
            })
          )
          yield* Ref.set(configured, Option.some(connection))
        }),
      describe: (p) =>
        read(p).pipe(
          Effect.mapError((reason) => new Connector.ParametersInvalid({ reason })),
          Effect.map(({ normalised }) => ({
            subject: normalised.repository,
            label: `Repository ${normalised.repository}`,
            parameters: normalised
          }))
        ),
      watch: ({ cursor, parameters: p }) =>
        Stream.unwrap(Effect.gen(function*() {
          const connection = yield* Ref.get(configured).pipe(
            Effect.flatMap(Effect.fromOption),
            Effect.mapError(() => new Connector.CredentialsRejected({ reason: "The github-repo connector is not configured" }))
          )
          const { filters, repository } = yield* read(p).pipe(
            Effect.mapError((reason) => new Connector.SourceFailed({ reason }))
          )
          const site: Site = {
            web: connection.host === "github.com" ? "https://github.com" : `https://${connection.host}`,
            repository: Repository.format(repository)
          }
          let last = cursor
          let first = true
          return Poll.watch(connection, repository, filters, site, cursor).pipe(
            Stream.mapError((error) => {
              switch (error._tag) {
                case "Unauthorized":
                  return new Connector.CredentialsRejected({ reason: error.reason })
                case "NotFound":
                  return new Connector.SourceFailed({
                    reason: `${error.reason}. ${Repository.format(repository)} does not exist, or the token cannot see it`
                  })
                case "Unavailable":
                  return new Connector.SourceFailed({ reason: error.reason })
              }
            }),
            Stream.flatMap((polled) => {
              const moved = polled.cursor !== last || first
              last = polled.cursor
              first = false
              const items = polled.events.map((event, i) =>
                toItem(event, i === polled.events.length - 1 ? polled.cursor : undefined)
              )
              if (items.length === 0 && moved) items.push(Connector.cursor(polled.cursor))
              return Stream.fromIterable(items)
            })
          )
        }))
    }
  })
})
