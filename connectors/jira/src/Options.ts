import { DateTime, Effect, Option } from "effect"
import type { Parameters, Target } from "./Target.ts"
import { TargetInvalid } from "./Target.ts"

export interface GitHubSignals {
  readonly repo: string
  readonly search: string
  readonly paths: ReadonlyArray<string>
  readonly since: string | undefined
  readonly sha: string | undefined
}

export interface Options {
  readonly fields: ReadonlyArray<string> | undefined
  readonly github: GitHubSignals | undefined
}

const Repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const Sha = /^[0-9a-f]{7,40}$/

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
  return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ""))]
}

const invalid = (reason: string) => Effect.fail(new TargetInvalid({ reason }))

export const parseOptions = (parameters: Parameters, target: Target): Effect.Effect<Options, TargetInvalid> =>
  Effect.gen(function*() {
    const fields = parameters.fields === undefined ? undefined : list(parameters.fields).map((field) => field.toLowerCase())
    if (fields !== undefined && fields.length === 0) return yield* invalid("fields is empty: name at least one field.")
    const repo = parameters.githubRepo?.trim()
    const paths = list(parameters.githubPaths)
    const search = parameters.githubSearch?.trim()
    const sinceText = parameters.since?.trim()
    const sha = parameters.sha?.trim().toLowerCase()
    if (repo === undefined || repo === "") {
      if (search !== undefined || paths.length > 0 || sinceText !== undefined || sha !== undefined) {
        return yield* invalid("githubSearch, githubPaths, since and sha need githubRepo.")
      }
      return { fields, github: undefined }
    }
    if (target.kind !== "issue") return yield* invalid("githubRepo watches one issue: give an issue key as the target.")
    if (!Repo.test(repo)) return yield* invalid(`githubRepo "${repo}" is not owner/repo.`)
    if (search === "") return yield* invalid("githubSearch is empty.")
    if (sha !== undefined && !Sha.test(sha)) return yield* invalid(`sha "${sha}" is not a commit SHA of 7 to 40 hex digits.`)
    let since: string | undefined
    if (sinceText !== undefined) {
      const time = DateTime.make(sinceText)
      if (Option.isNone(time)) return yield* invalid(`since "${sinceText}" is not an ISO time.`)
      since = DateTime.formatIso(DateTime.toUtc(time.value))
    }
    return { fields, github: { repo, search: search ?? target.key, paths, since, sha } }
  })

export const normaliseOptions = (parameters: Parameters, options: Options): Partial<Parameters> => {
  const github = options.github
  return {
    ...(options.fields === undefined ? {} : { fields: list(parameters.fields) }),
    ...(github === undefined ? {} : {
      githubRepo: github.repo,
      ...(parameters.githubSearch === undefined ? {} : { githubSearch: github.search }),
      ...(github.paths.length === 0 ? {} : { githubPaths: github.paths }),
      ...(github.since === undefined ? {} : { since: github.since }),
      ...(github.sha === undefined ? {} : { sha: github.sha })
    })
  }
}

export const reportsField = (
  fields: ReadonlyArray<string> | undefined,
  change: { readonly field: string; readonly fieldId: string | null }
): boolean =>
  fields === undefined ||
  fields.includes(change.field.toLowerCase()) ||
  (change.fieldId !== null && fields.includes(change.fieldId.toLowerCase()))
