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
 * GitHub numbers releases in creation order, so one above `newest` is new. `drafts` are the drafts the last poll saw,
 * which are new when they are published.
 */
export interface ReleaseMemory {
  readonly patterns: ReadonlyArray<string>
  readonly newest: number
  readonly drafts: ReadonlyArray<number>
}

export interface RunMark {
  readonly id: number
  readonly attempt: number
  readonly completed: boolean
}

/** GitHub numbers runs in creation order, so one above `newest` is new; `runs` are the runs the last poll listed. */
export interface RunMemory {
  readonly newest: number
  readonly runs: ReadonlyArray<RunMark>
}

export interface Memory {
  readonly tags: RefMemory | null
  readonly branches: RefMemory | null
  readonly releases: ReleaseMemory | null
  readonly workflows: ReadonlyMap<string, RunMemory>
}

/** Where links point: the web root of the host and the repository's path on it. */
export interface Site {
  readonly web: string
  readonly repository: string
}

const short = (sha: string) => sha.slice(0, 7)

const samePatterns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((pattern, i) => pattern === right[i])
}

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
  const refs = new Map([...current].filter(([name]) => matchesAny(globs, name)))
  const memory = { patterns, refs }
  if (previous === null || !samePatterns(previous.patterns, patterns)) return { events: [], memory }
  const root = `${site.web}/${site.repository}`
  const label = kind === "tag" ? "Tag" : "Branch"
  const events: Array<Emitted> = []
  for (const [name, sha] of refs) {
    const before = previous.refs.get(name)
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
    for (const [name, before] of previous.refs) {
      if (refs.has(name)) continue
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

const newestOf = (ids: ReadonlyArray<number>, floor: number) => ids.reduce((a, b) => (a > b ? a : b), floor)

const diffReleases = (
  previous: ReleaseMemory | null,
  current: ReadonlyArray<Release> | null,
  globs: ReadonlyArray<Glob>
): { readonly events: ReadonlyArray<Emitted>; readonly memory: ReleaseMemory | null } => {
  if (current === null) return { events: [], memory: null }
  const patterns = globs.map((glob) => glob.source)
  const memory = {
    patterns,
    newest: newestOf(current.map((r) => r.id), previous?.newest ?? 0),
    drafts: current.filter((r) => r.draft).map((r) => r.id)
  }
  if (previous === null || !samePatterns(previous.patterns, patterns)) return { events: [], memory }
  const events: Array<Emitted> = current
    .filter((r): r is Release & { publishedAt: string } =>
      !r.draft && r.publishedAt !== null && matchesAny(globs, r.tag) &&
      (r.id > previous.newest || previous.drafts.includes(r.id))
    )
    .reverse()
    .map((r) => ({
      type: "release.published",
      occurredAt: r.publishedAt,
      summary: `Release ${r.name || r.tag} published${r.prerelease ? " as a prerelease" : ""}`,
      payload: { id: r.id, tag: r.tag, name: r.name, prerelease: r.prerelease, url: r.url },
      link: r.url,
      dedupeKey: `release.published/${r.id}`
    }))
  return { events, memory }
}

const runPayload = (workflow: string, run: Run) => ({
  workflow,
  name: run.name,
  runId: run.id,
  attempt: run.attempt,
  runNumber: run.runNumber,
  branch: run.branch,
  sha: run.sha,
  event: run.event,
  url: run.url
})

const where = (run: Run) => `${run.name} run #${run.runNumber}${run.branch === null ? "" : ` on ${run.branch}`}`

const diffRuns = (
  workflow: string,
  previous: RunMemory | undefined,
  current: ReadonlyArray<Run>
): { readonly events: ReadonlyArray<Emitted>; readonly memory: RunMemory } => {
  const memory = {
    newest: newestOf(current.map((run) => run.id), previous?.newest ?? 0),
    runs: current.map((run) => ({ id: run.id, attempt: run.attempt, completed: run.completed }))
  }
  if (previous === undefined) return { events: [], memory }
  const events: Array<Emitted> = []
  for (const run of [...current].reverse()) {
    const before = previous.runs.find((mark) => mark.id === run.id)
    if (before === undefined && run.id <= previous.newest) continue
    const newAttempt = before === undefined || run.attempt > before.attempt
    if (newAttempt && !run.completed) {
      events.push({
        type: "workflow.started",
        occurredAt: run.updatedAt,
        summary: `${where(run)} started`,
        payload: runPayload(workflow, run),
        link: run.url,
        dedupeKey: `workflow.started/${run.id}/${run.attempt}`
      })
    }
    if (run.completed && (newAttempt || !before.completed)) {
      events.push({
        type: "workflow.completed",
        occurredAt: run.updatedAt,
        summary: `${where(run)} finished: ${run.conclusion ?? "no conclusion"}`,
        payload: { ...runPayload(workflow, run), conclusion: run.conclusion },
        link: run.url,
        dedupeKey: `workflow.completed/${run.id}/${run.attempt}`
      })
    }
  }
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
  const workflows = new Map<string, RunMemory>()
  for (const workflow of filters.workflows) {
    const before = memory?.workflows.get(workflow)
    const runs = snapshot.workflows.get(workflow)
    if (runs == null) {
      if (before !== undefined) workflows.set(workflow, before)
      continue
    }
    const diffed = diffRuns(workflow, before, runs)
    events.push(...diffed.events)
    workflows.set(workflow, diffed.memory)
  }
  return {
    events,
    memory: { tags: tags.memory, branches: branches.memory, releases: releases.memory, workflows }
  }
}
