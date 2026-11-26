import type { Emitted } from "./Events.ts"
import { type Glob, matchesAny } from "./Glob.ts"
import type { Refs, Release, Run, Snapshot } from "./Snapshot.ts"

export interface Filters {
  readonly tags: ReadonlyArray<Glob>
  readonly branches: ReadonlyArray<Glob>
  readonly releases: ReadonlyArray<Glob>
  readonly workflows: ReadonlyArray<string>
}

/** The refs matching `patterns` at the last poll. */
export interface RefMemory {
  readonly patterns: ReadonlyArray<string>
  readonly refs: Refs
}

/**
 * The newest releases or runs the last poll listed. `floor` is the oldest time among them: something the list shows
 * later that is older than the floor moved up because a newer one was deleted, and is not new.
 */
export interface Window {
  readonly seen: ReadonlyArray<string>
  readonly floor: string | null
}

export interface Memory {
  readonly tags: RefMemory | null
  readonly branches: RefMemory | null
  readonly releases: (Window & { readonly patterns: ReadonlyArray<string> }) | null
  readonly workflows: Readonly<Record<string, Window>>
}

/** Where links point: the web root of the host and the repository's path on it. */
export interface Site {
  readonly web: string
  readonly repository: string
}

const short = (sha: string) => sha.slice(0, 7)

const samePatterns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((pattern, i) => pattern === b[i])

const diffRefs = (
  kind: "tag" | "branch",
  previous: RefMemory | null,
  current: Refs | null,
  globs: ReadonlyArray<Glob>,
  site: Site,
  now: string
): { readonly events: ReadonlyArray<Emitted>; readonly memory: RefMemory | null } => {
  if (current === null) return { events: [], memory: null }
  const patterns = globs.map((glob) => glob.source)
  const refs: Record<string, string> = {}
  for (const [name, sha] of Object.entries(current)) if (matchesAny(globs, name)) refs[name] = sha
  const memory = { patterns, refs }
  if (previous === null || !samePatterns(previous.patterns, patterns)) return { events: [], memory }
  const root = `${site.web}/${site.repository}`
  const label = kind === "tag" ? "Tag" : "Branch"
  const events: Array<Emitted> = []
  for (const [name, sha] of Object.entries(refs)) {
    const before = previous.refs[name]
    if (before === undefined) {
      events.push({
        type: `${kind}.created`,
        occurredAt: now,
        summary: `${label} ${name} created at ${short(sha)}`,
        payload: { name, sha },
        link: `${root}/tree/${encodeURIComponent(name)}`,
        dedupeKey: `${kind}.created/${name}/${sha}`
      })
    } else if (before !== sha) {
      events.push({
        type: `${kind}.moved`,
        occurredAt: now,
        summary: `${label} ${name} moved from ${short(before)} to ${short(sha)}`,
        payload: { name, sha, previous: before },
        link: `${root}/compare/${before}...${sha}`,
        dedupeKey: `${kind}.moved/${name}/${before}/${sha}`
      })
    }
  }
  if (kind === "branch") {
    for (const [name, before] of Object.entries(previous.refs)) {
      if (refs[name] !== undefined) continue
      events.push({
        type: "branch.deleted",
        occurredAt: now,
        summary: `Branch ${name} deleted; it was at ${short(before)}`,
        payload: { name, previous: before },
        link: `${root}/commit/${before}`,
        dedupeKey: `branch.deleted/${name}/${before}`
      })
    }
  }
  return { events, memory }
}

const oldest = (times: ReadonlyArray<string>) => times.length === 0 ? null : times.reduce((a, b) => (a < b ? a : b))

const isNew = (window: Window, key: string, at: string) =>
  !window.seen.includes(key) && (window.floor === null || at >= window.floor)

const diffReleases = (
  previous: Memory["releases"],
  current: ReadonlyArray<Release> | null,
  globs: ReadonlyArray<Glob>
): { readonly events: ReadonlyArray<Emitted>; readonly memory: Memory["releases"] } => {
  if (current === null) return { events: [], memory: null }
  const published = current.filter((r): r is Release & { publishedAt: string } => !r.draft && r.publishedAt !== null)
  const patterns = globs.map((glob) => glob.source)
  const memory = {
    patterns,
    seen: published.map((r) => r.id),
    floor: oldest(published.map((r) => r.publishedAt))
  }
  if (previous === null || !samePatterns(previous.patterns, patterns)) return { events: [], memory }
  const events: Array<Emitted> = published
    .filter((r) => matchesAny(globs, r.tag) && isNew(previous, r.id, r.publishedAt))
    .reverse()
    .map((r) => ({
      type: "release.published",
      occurredAt: r.publishedAt,
      summary: `Release ${r.name || r.tag} published${r.prerelease ? " as a prerelease" : ""}`,
      payload: { id: r.id, tag: r.tag, name: r.name, prerelease: r.prerelease, url: r.url },
      link: r.url,
      dedupeKey: `release.published/${r.id}`
    }))
  return { events, memory: { ...memory, floor: memory.floor ?? previous.floor } }
}

const runKey = (run: Run) => `${run.id}/${run.attempt}`

const diffRuns = (
  workflow: string,
  previous: Window | undefined,
  current: ReadonlyArray<Run>
): { readonly events: ReadonlyArray<Emitted>; readonly memory: Window } => {
  const memory = { seen: current.map(runKey), floor: oldest(current.map((run) => run.updatedAt)) ?? previous?.floor ?? null }
  if (previous === undefined) return { events: [], memory }
  const events: Array<Emitted> = current
    .filter((run) => isNew(previous, runKey(run), run.updatedAt))
    .reverse()
    .map((run) => ({
      type: "workflow.completed",
      occurredAt: run.updatedAt,
      summary: `${run.name} run #${run.runNumber}${run.branch === null ? "" : ` on ${run.branch}`} finished: ${
        run.conclusion ?? "no conclusion"
      }`,
      payload: {
        workflow,
        name: run.name,
        runId: run.id,
        attempt: run.attempt,
        runNumber: run.runNumber,
        conclusion: run.conclusion,
        branch: run.branch,
        sha: run.sha,
        event: run.event,
        url: run.url
      },
      link: run.url,
      dedupeKey: `workflow.completed/${run.id}/${run.attempt}`
    }))
  return { events, memory }
}

export interface Stepped {
  readonly events: ReadonlyArray<Emitted>
  readonly memory: Memory
}

/**
 * Compares a poll with the last one. A part seen for the first time, or after its patterns changed, is a silent
 * baseline: what exists then is not reported.
 */
export const step = (
  memory: Memory | undefined,
  snapshot: Snapshot,
  filters: Filters,
  site: Site,
  now: string
): Stepped => {
  const tags = diffRefs("tag", memory?.tags ?? null, snapshot.tags, filters.tags, site, now)
  const branches = diffRefs("branch", memory?.branches ?? null, snapshot.branches, filters.branches, site, now)
  const releases = diffReleases(memory?.releases ?? null, snapshot.releases, filters.releases)
  const events: Array<Emitted> = [...tags.events, ...branches.events, ...releases.events]
  const workflows: Record<string, Window> = {}
  for (const workflow of filters.workflows) {
    const before = memory?.workflows[workflow]
    const runs = snapshot.workflows[workflow]
    if (runs == null) {
      if (before !== undefined) workflows[workflow] = before
      continue
    }
    const diffed = diffRuns(workflow, before, runs)
    events.push(...diffed.events)
    workflows[workflow] = diffed.memory
  }
  return {
    events,
    memory: { tags: tags.memory, branches: branches.memory, releases: releases.memory, workflows }
  }
}
