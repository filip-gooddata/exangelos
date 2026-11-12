import type { Emitted } from "./Events.ts"
import type { Check, Comment, Review, Snapshot, Thread } from "./Snapshot.ts"

export type { Emitted, EventType } from "./Events.ts"

type Draft = Emitted extends infer E ? E extends Emitted ? Omit<E, "occurredAt"> & { readonly occurredAt?: string | null } : never
  : never

export type EndReason = "merged" | "closed"

/**
 * The newest creation time seen in a connection and the ids created at that
 * instant, so an item sharing the timestamp is still told apart.
 */
export interface Mark {
  readonly at: string | null
  readonly ids: ReadonlyArray<string>
}

/** What the diff remembers between polls. Flags and ids are scoped to `head`. */
export interface Memory {
  readonly head: string
  readonly base: { readonly name: string; readonly oid: string }
  readonly conflictReported: boolean
  readonly failedReported: ReadonlyArray<string>
  readonly passedReported: boolean
  readonly readyReported: boolean
  readonly reviews: Mark
  readonly comments: Mark
  readonly threads: Mark
}

export interface Filters {
  readonly checks: ReadonlyArray<RegExp>
  readonly authors: ReadonlyArray<RegExp>
  readonly comments: ReadonlyArray<RegExp>
}

export const noFilters: Filters = { checks: [], authors: [], comments: [] }

export interface Step {
  readonly events: ReadonlyArray<Emitted>
  readonly memory: Memory
  readonly end: EndReason | null
}

const matchesAny = (patterns: ReadonlyArray<RegExp>, text: string) => patterns.some((p) => p.test(text))

const isNew = (mark: Mark, id: string, at: string) =>
  mark.at === null || at > mark.at || (at === mark.at && !mark.ids.includes(id))

const advance = <A extends { readonly id: string }>(mark: Mark, items: ReadonlyArray<A>, at: (a: A) => string): Mark =>
  items.reduce<Mark>((m, item) => {
    const t = at(item)
    if (m.at === null || t > m.at) return { at: t, ids: [item.id] }
    if (t === m.at && !m.ids.includes(item.id)) return { at: t, ids: [...m.ids, item.id] }
    return m
  }, mark)

/**
 * The current run of each check, told apart by kind and name since a check
 * run and a commit status may share a name: one still running wins, else the
 * last to complete.
 */
const latestByName = (checks: ReadonlyArray<Check>): ReadonlyArray<Check> => {
  const byName = new Map<string, Check>()
  for (const check of checks) {
    const key = `${check.kind}:${check.name}`
    const seen = byName.get(key)
    if (
      seen === undefined ||
      check.completedAt === null ||
      (seen.completedAt !== null && check.completedAt >= seen.completedAt)
    ) {
      byName.set(key, check)
    }
  }
  return [...byName.values()]
}

const isFailure = (check: Check) => check.outcome === "failed" || check.outcome === "cancelled"

/**
 * Compares a poll with what earlier polls saw. Without `previous` the poll is
 * the baseline: history before it raises nothing, while the state it shows
 * (a conflict, failed or passed checks, readiness) does.
 */
export const step = (previous: Memory | undefined, snapshot: Snapshot, filters: Filters, now: string): Step => {
  const events: Array<Emitted> = []
  const emit = (event: Draft) => events.push({ ...event, occurredAt: event.occurredAt ?? now } as Emitted)
  const { head, base } = snapshot
  const headChanged = previous !== undefined && previous.head !== head
  const baseChanged = previous !== undefined && (previous.base.oid !== base.oid || previous.base.name !== base.name)
  const sameHead = previous !== undefined && !headChanged

  if (headChanged) {
    emit({
      type: "head.changed",
      summary: `Head moved to ${head.slice(0, 7)}`,
      payload: { previous: previous.head, head },
      link: snapshot.url,
      dedupeKey: `head.changed/${head}`
    })
  }
  if (baseChanged) {
    emit({
      type: "base.changed",
      summary: `Base ${base.name} moved to ${base.oid.slice(0, 7)}`,
      payload: { previous: previous.base, base },
      link: snapshot.url,
      dedupeKey: `base.changed/${base.name}/${base.oid}`
    })
  }

  const conflictReported = sameHead && !baseChanged && previous.conflictReported
  const conflicting = snapshot.state === "OPEN" && snapshot.mergeable === "CONFLICTING"
  if (conflicting && !conflictReported) {
    emit({
      type: "conflict.detected",
      summary: `Conflicts with ${base.name}`,
      payload: { head, base },
      link: snapshot.url,
      dedupeKey: `conflict.detected/${head}/${base.oid}`
    })
  }

  const current = latestByName(snapshot.checks)
  const checks = current.filter((c) => !matchesAny(filters.checks, c.name))
  const failedReported = new Set(sameHead ? previous.failedReported : [])
  for (const check of checks.filter(isFailure)) {
    if (failedReported.has(check.id)) continue
    failedReported.add(check.id)
    emit({
      type: "checks.failed",
      occurredAt: check.completedAt,
      summary: `Check ${check.name} ${check.outcome === "cancelled" ? "was cancelled" : "failed"}`,
      payload: { name: check.name, outcome: check.outcome === "cancelled" ? "cancelled" : "failed", required: check.required, head },
      link: check.url ?? snapshot.url,
      dedupeKey: `checks.failed/${head}/${check.id}`
    })
  }

  const visible = (author: string, body: string | null) =>
    !matchesAny(filters.authors, author) && (body === null || !matchesAny(filters.comments, body))

  const fresh = <A extends { readonly id: string }>(
    mark: Mark | undefined,
    items: ReadonlyArray<A>,
    at: (a: A) => string
  ): { readonly items: ReadonlyArray<A>; readonly mark: Mark } => {
    if (mark === undefined) return { items: [], mark: advance({ at: null, ids: [] }, items, at) }
    return { items: items.filter((item) => isNew(mark, item.id, at(item))), mark: advance(mark, items, at) }
  }

  const threads = fresh<Thread>(previous?.threads, snapshot.threads, (t) => t.createdAt)
  for (const thread of threads.items) {
    if (thread.isResolved || !visible(thread.author, thread.body)) continue
    emit({
      type: "review.thread",
      occurredAt: thread.createdAt,
      summary: `${thread.author} opened a review thread on ${thread.path}`,
      payload: { id: thread.id, author: thread.author, path: thread.path, body: thread.body },
      link: thread.url,
      dedupeKey: `review.thread/${thread.id}`
    })
  }

  const reviews = fresh<Review>(previous?.reviews, snapshot.reviews, (r) => r.submittedAt)
  for (const review of reviews.items) {
    if (!visible(review.author, null)) continue
    emit({
      type: "review.submitted",
      occurredAt: review.submittedAt,
      summary: `${review.author} submitted a review: ${review.state.toLowerCase().replaceAll("_", " ")}`,
      payload: { id: review.id, author: review.author, state: review.state, body: review.body },
      link: review.url,
      dedupeKey: `review.submitted/${review.id}`
    })
  }

  const comments = fresh<Comment>(previous?.comments, snapshot.comments, (c) => c.createdAt)
  for (const comment of comments.items) {
    if (!visible(comment.author, comment.body)) continue
    emit({
      type: "comment.added",
      occurredAt: comment.createdAt,
      summary: `${comment.author} commented`,
      payload: { id: comment.id, author: comment.author, body: comment.body },
      link: comment.url,
      dedupeKey: `comment.added/${comment.id}`
    })
  }

  const allPassed = checks.length > 0 && checks.every((c) => c.outcome === "passed")
  const missingRequired = snapshot.requiredChecks.some(
    (name) => !matchesAny(filters.checks, name) && !checks.some((c) => c.name === name)
  )
  let passedReported = sameHead && previous.passedReported
  if (allPassed && !missingRequired && !passedReported) {
    passedReported = true
    emit({
      type: "checks.passed",
      summary: `All ${checks.length} checks passed`,
      payload: { head, checks: checks.map((c) => c.name) },
      link: snapshot.url,
      dedupeKey: `checks.passed/${head}`
    })
  }

  // Ignore patterns quiet notifications only: GitHub still blocks the merge on an ignored required check.
  const required = current.filter((c) => c.required || snapshot.requiredChecks.includes(c.name))
  const requiredPassed = required.every((c) => c.outcome === "passed") &&
    snapshot.requiredChecks.every((name) => current.some((c) => c.name === name))
  const approved = snapshot.reviewDecision === "APPROVED" || snapshot.reviewDecision === null
  const ready = snapshot.state === "OPEN" && !snapshot.isDraft && snapshot.mergeable === "MERGEABLE" && approved &&
    requiredPassed
  let readyReported = sameHead && previous.readyReported
  if (ready && !readyReported) {
    readyReported = true
    emit({
      type: "merge.ready",
      summary: "Ready to merge",
      payload: { head, reviewDecision: snapshot.reviewDecision },
      link: snapshot.url,
      dedupeKey: `merge.ready/${head}`
    })
  }

  const end: EndReason | null = snapshot.state === "MERGED" ? "merged" : snapshot.state === "CLOSED" ? "closed" : null

  return {
    events,
    end,
    memory: {
      head,
      base: { name: base.name, oid: base.oid },
      conflictReported: conflicting || conflictReported,
      failedReported: [...failedReported],
      passedReported,
      readyReported,
      reviews: reviews.mark,
      comments: comments.mark,
      threads: threads.mark
    }
  }
}
