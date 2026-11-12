import { Schema } from "effect"
import type { Fingerprint, Snapshot } from "./Tree.ts"

/** How many paths a cursor keeps. Past it, catch-up works from modification times alone. */
export const cursorCap = 2000

/**
 * What the plugin last knew. A live run knows a fingerprint per file. A
 * cursor knows, as of `at`, the first `cursorCap` matching paths in sorted
 * order, and `complete` says whether those were all of them.
 */
export type Baseline =
  | { readonly _tag: "Known"; readonly files: Snapshot }
  | { readonly _tag: "Remembered"; readonly at: number; readonly paths: ReadonlySet<string>; readonly last: string | undefined; readonly complete: boolean }

export const empty: Baseline = { _tag: "Known", files: new Map() }

export type Change =
  | { readonly type: "file.created" | "file.changed"; readonly path: string; readonly file: Fingerprint }
  | { readonly type: "file.deleted"; readonly path: string; readonly lastModifiedAt: number }

const within = (scope: string, path: string) => scope === "" || path === scope || path.startsWith(`${scope}/`)

const knownPaths = (baseline: Baseline): Iterable<string> =>
  baseline._tag === "Known" ? baseline.files.keys() : baseline.paths

const appeared = (baseline: Baseline, path: string, file: Fingerprint): Change | undefined => {
  if (baseline._tag === "Known") {
    const before = baseline.files.get(path)
    if (before === undefined) return { type: "file.created", path, file }
    return before.modifiedAt === file.modifiedAt && before.size === file.size
      ? undefined
      : { type: "file.changed", path, file }
  }
  const remembered = baseline.paths.has(path)
  const covered = remembered || baseline.complete || (baseline.last !== undefined && path <= baseline.last)
  if (file.modifiedAt <= baseline.at) return covered && !remembered ? { type: "file.created", path, file } : undefined
  if (covered) return { type: remembered ? "file.changed" : "file.created", path, file }
  return { type: file.bornAt !== undefined && file.bornAt > baseline.at ? "file.created" : "file.changed", path, file }
}

/**
 * The changes between what the baseline knew below `scope` and what the
 * plugin now observes there, in path order.
 */
export const diff = (baseline: Baseline, observed: Snapshot, scope = ""): Array<Change> => {
  const changes: Array<Change> = []
  for (const [path, file] of observed) {
    const change = appeared(baseline, path, file)
    if (change !== undefined) changes.push(change)
  }
  for (const path of knownPaths(baseline)) {
    if (!within(scope, path) || observed.has(path)) continue
    const lastModifiedAt = baseline._tag === "Known" ? baseline.files.get(path)!.modifiedAt : baseline.at
    changes.push({ type: "file.deleted", path, lastModifiedAt })
  }
  return changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/** The live baseline after replacing everything below `scope` with what was observed. */
export const update = (files: Snapshot, observed: Snapshot, scope = ""): Snapshot => {
  const next = new Map(files)
  for (const path of files.keys()) if (within(scope, path) && !observed.has(path)) next.delete(path)
  for (const [path, file] of observed) next.set(path, file)
  return next
}

const CursorJson = Schema.fromJsonString(Schema.Struct({
  v: Schema.Literal(1),
  at: Schema.Finite,
  paths: Schema.Array(Schema.String),
  complete: Schema.Boolean
}))

/**
 * Encodes a cursor. `at` is the time from which later modifications count as
 * unseen; the caller sets it early enough to cover changes still settling.
 */
export const encodeCursor = (files: Snapshot, at: number): string => {
  const paths = [...files.keys()].sort()
  return Schema.encodeSync(CursorJson)({
    v: 1,
    at,
    paths: paths.slice(0, cursorCap),
    complete: paths.length <= cursorCap
  })
}

/** Reads a cursor. An unreadable cursor counts as none, so the run starts fresh. */
export const decodeCursor = (cursor: string | undefined): Baseline | undefined => {
  if (cursor === undefined) return undefined
  try {
    const { at, paths, complete } = Schema.decodeSync(CursorJson)(cursor)
    return { _tag: "Remembered", at, paths: new Set(paths), last: paths.at(-1), complete }
  } catch {
    return undefined
  }
}
