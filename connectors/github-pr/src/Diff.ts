import type { Emitted } from "./Events.ts"
import type { Check, Comment, Review, ReviewRequest, Snapshot, Thread } from "./Snapshot.ts"

export type { Emitted, EventType } from "./Events.ts"

type Draft = Emitted extends infer E ? E extends Emitted ? Omit<E, "occurredAt"> & { readonly occurredAt?: string | null } : never
  : never

export type EndReason = "merged" | "closed"

export interface Mark {
  readonly at: string | null
  readonly ids: ReadonlyArray<string>
}

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
  readonly replies: Mark
  readonly requests: Mark
  /** The draft state seen last and how many times it changed; null until a poll has seen it. */
  readonly draft: { readonly isDraft: boolean; readonly changes: number } | null
  /** Names of checks already reported by `check.passed` for this head. */
  readonly checkPassed: ReadonlyArray<string>
  /** The base oid `base.changed` compares against, and the `baseHead` parameter it came from. */
  readonly pin: { readonly param: string; readonly oid: string } | null
  /** The reviewer of reviewer mode and the time of their latest submitted review. */
  readonly reviewer: { readonly login: string; readonly reviewedAt: string | null } | null
}

export interface Filters {
  readonly checks: ReadonlyArray<RegExp>
  readonly authors: ReadonlyArray<RegExp>
  readonly comments: ReadonlyArray<RegExp>
  /** Node ids, URLs or URL fragments of threads, comments and reviews that never notify. */
  readonly ignoreIds: ReadonlyArray<string>
  readonly checkPass: ReadonlyArray<RegExp>
  readonly readyWait: ReadonlyArray<RegExp>
  /** Review states `review.submitted` reports; null for all. */
  readonly reviewStates: ReadonlyArray<string> | null
  readonly reviewer: string | null
  /** A base oid (or prefix) to compare against, or "current" for the base seen first; null to report every move. */
  readonly baseHead: string | null
  readonly existingThreads: boolean
}

export const noFilters: Filters = {
  checks: [],
  authors: [],
  comments: [],
  ignoreIds: [],
  checkPass: [],
  readyWait: [],
  reviewStates: null,
  reviewer: null,
  baseHead: null,
  existingThreads: false
}

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

const fragment = (url: string) => {
  const at = url.indexOf("#")
  return at < 0 ? "" : url.slice(at + 1)
}

const draftState = (isDraft: boolean) => isDraft ? "draft" as const : "ready" as const

export const step = (previous: Memory | undefined, snapshot: Snapshot, filters: Filters, now: string): Step => {
  const events: Array<Emitted> = []
  const emit = (event: Draft) => events.push({ ...event, occurredAt: event.occurredAt ?? now } as Emitted)
  const { head, base } = snapshot
  const headChanged = previous !== undefined && previous.head !== head
  const baseMoved = previous !== undefined && (previous.base.oid !== base.oid || previous.base.name !== base.name)
  const sameHead = previous !== undefined && !headChanged
  const ignored = new Set(filters.ignoreIds)
  const muted = (id: string, url: string | null) =>
    ignored.has(id) || (url !== null && (ignored.has(url) || (fragment(url) !== "" && ignored.has(fragment(url)))))
  const threadMuted = (thread: Thread) => muted(thread.id, null) || muted(thread.openerId, thread.url)

  if (headChanged) {
    emit({
      type: "head.changed",
      summary: `Head moved to ${head.slice(0, 7)}`,
      payload: { previous: previous.head, head },
      link: snapshot.url,
      dedupeKey: `head.changed/${head}`
    })
  }

  const draftBefore = previous?.draft ?? null
  let draft = { isDraft: snapshot.isDraft, changes: draftBefore?.changes ?? 0 }
  if (draftBefore !== null && draftBefore.isDraft !== snapshot.isDraft) {
    draft = { isDraft: snapshot.isDraft, changes: draftBefore.changes + 1 }
    const from = draftState(draftBefore.isDraft)
    const to = draftState(snapshot.isDraft)
    if (snapshot.state === "OPEN") {
      emit({
        type: "draft.changed",
        summary: snapshot.isDraft ? "Turned back into a draft" : "Ready for review",
        payload: { head, from, to },
        link: snapshot.url,
        dedupeKey: `draft.changed/${head}/${from}-${to}/${draft.changes}`
      })
    }
  }

  let pin: Memory["pin"] = null
  if (filters.baseHead === null) {
    if (baseMoved) {
      emit({
        type: "base.changed",
        summary: `Base ${base.name} moved to ${base.oid.slice(0, 7)}`,
        payload: { previous: previous.base, base },
        link: snapshot.url,
        dedupeKey: `base.changed/${base.name}/${base.oid}`
      })
    }
  } else {
    const param = filters.baseHead
    const oid = param !== "current"
      ? param
      : previous?.pin?.param === "current"
      ? previous.pin.oid
      : previous?.base.oid ?? base.oid
    pin = { param, oid }
    const repinned = previous?.pin?.param !== param
    if (!base.oid.startsWith(oid) && (previous === undefined || baseMoved || repinned)) {
      emit({
        type: "base.changed",
        summary: `Base ${base.name} is at ${base.oid.slice(0, 7)}, not the pinned ${oid.slice(0, 7)}`,
        payload: { previous: { name: base.name, oid }, base },
        link: snapshot.url,
        dedupeKey: `base.changed/${base.name}/${base.oid}`
      })
    }
  }

  const conflictReported = sameHead && !baseMoved && previous.conflictReported
  const conflicting = snapshot.state === "OPEN" &&
    (snapshot.mergeable === "CONFLICTING" || snapshot.mergeStateStatus === "DIRTY")
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
  const announced = previous === undefined && filters.existingThreads ? snapshot.threads : threads.items
  for (const thread of announced) {
    if (thread.isResolved || !visible(thread.author, thread.body) || threadMuted(thread)) continue
    emit({
      type: "review.thread",
      occurredAt: thread.createdAt,
      summary: `${thread.author} opened a review thread on ${thread.path}`,
      payload: { id: thread.id, author: thread.author, path: thread.path, body: thread.body },
      link: thread.url,
      dedupeKey: `review.thread/${thread.id}`
    })
  }

  interface Reply {
    readonly id: string
    readonly thread: Thread
    readonly comment: Comment
  }
  const replies = fresh<Reply>(
    previous?.replies,
    snapshot.threads.flatMap((thread) => thread.replies.map((comment) => ({ id: comment.id, thread, comment }))),
    (r) => r.comment.createdAt
  )
  for (const { comment, thread } of replies.items) {
    if (threadMuted(thread) || muted(comment.id, comment.url) || !visible(comment.author, comment.body)) continue
    emit({
      type: "review.reply",
      occurredAt: comment.createdAt,
      summary: `${comment.author} replied in a review thread on ${thread.path}`,
      payload: {
        threadId: thread.id,
        commentId: comment.id,
        author: comment.author,
        path: thread.path,
        body: comment.body,
        isResolved: thread.isResolved
      },
      link: comment.url,
      dedupeKey: `review.reply/${comment.id}`
    })
  }

  const reviews = fresh<Review>(previous?.reviews, snapshot.reviews, (r) => r.submittedAt)
  for (const review of reviews.items) {
    if (!visible(review.author, null) || muted(review.id, review.url)) continue
    if (filters.reviewStates !== null && !filters.reviewStates.includes(review.state)) continue
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
    if (!visible(comment.author, comment.body) || muted(comment.id, comment.url)) continue
    emit({
      type: "comment.added",
      occurredAt: comment.createdAt,
      summary: `${comment.author} commented`,
      payload: { id: comment.id, author: comment.author, body: comment.body },
      link: comment.url,
      dedupeKey: `comment.added/${comment.id}`
    })
  }

  const requests = fresh<ReviewRequest>(previous?.requests, snapshot.reviewRequests, (r) => r.createdAt)
  let reviewer: Memory["reviewer"] = null
  if (filters.reviewer !== null) {
    const login = filters.reviewer
    const same = (name: string | null) => name !== null && name.toLowerCase() === login.toLowerCase()
    const before = previous?.reviewer !== undefined && previous.reviewer !== null && same(previous.reviewer.login)
      ? previous.reviewer
      : null
    const latest = (times: ReadonlyArray<string | null>) =>
      times.reduce<string | null>((max, t) => t !== null && (max === null || t > max) ? t : max, null)
    const reviewedAt = latest([before?.reviewedAt ?? null, ...snapshot.reviews.filter((r) => same(r.author)).map((r) => r.submittedAt)])
    reviewer = { login, reviewedAt }

    for (const review of reviews.items) {
      if (!same(review.author) || muted(review.id, review.url)) continue
      emit({
        type: "reviewer.submitted",
        occurredAt: review.submittedAt,
        summary: `${review.author} submitted a review: ${review.state.toLowerCase().replaceAll("_", " ")}`,
        payload: {
          reviewer: review.author,
          reviewId: review.id,
          state: review.state,
          submittedAt: review.submittedAt,
          commit: review.commit
        },
        link: review.url,
        dedupeKey: `reviewer.submitted/${review.id}`
      })
    }

    const asked = snapshot.reviewRequests.filter((r) => same(r.reviewer))
    const candidates = before === null
      ? (snapshot.requestedReviewers.some(same) ? asked.slice(-1) : [])
      : requests.items.filter((r) => same(r.reviewer))
    for (const request of candidates) {
      if (reviewedAt === null || reviewedAt >= request.createdAt) continue
      emit({
        type: "review.rerequested",
        occurredAt: request.createdAt,
        summary: `${login} was asked to review again`,
        payload: { reviewer: login, requestId: request.id, requestedAt: request.createdAt, reviewedAt },
        link: snapshot.url,
        dedupeKey: `review.rerequested/${request.id}`
      })
    }

    const byAuthor = (author: string) => author === snapshot.author
    const activity: Array<{
      readonly kind: "comment" | "thread" | "reply"
      readonly id: string
      readonly thread: Thread | null
      readonly body: string
      readonly at: string
      readonly url: string
    }> = [
      ...comments.items.filter((c) => byAuthor(c.author) && !muted(c.id, c.url)).map((c) => ({
        kind: "comment" as const,
        id: c.id,
        thread: null,
        body: c.body,
        at: c.createdAt,
        url: c.url
      })),
      ...threads.items.filter((t) => byAuthor(t.author) && !threadMuted(t)).map((t) => ({
        kind: "thread" as const,
        id: t.openerId,
        thread: t,
        body: t.body,
        at: t.createdAt,
        url: t.url
      })),
      ...replies.items.filter((r) => byAuthor(r.comment.author) && !threadMuted(r.thread) && !muted(r.id, r.comment.url))
        .map((r) => ({ kind: "reply" as const, id: r.id, thread: r.thread, body: r.comment.body, at: r.comment.createdAt, url: r.comment.url }))
    ]
    for (const item of activity) {
      if (!visible(snapshot.author, item.body)) continue
      emit({
        type: "author.activity",
        occurredAt: item.at,
        summary: item.kind === "comment"
          ? `${snapshot.author} commented`
          : `${snapshot.author} wrote in a review thread on ${item.thread?.path}`,
        payload: {
          author: snapshot.author,
          kind: item.kind,
          id: item.id,
          threadId: item.thread?.id ?? null,
          path: item.thread?.path ?? null,
          body: item.body
        },
        link: item.url,
        dedupeKey: `author.activity/${item.id}`
      })
    }
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

  const checkPassed = new Set(sameHead ? previous.checkPassed : [])
  for (const check of checks) {
    if (check.outcome !== "passed" || !matchesAny(filters.checkPass, check.name) || checkPassed.has(check.name)) continue
    checkPassed.add(check.name)
    emit({
      type: "check.passed",
      occurredAt: check.completedAt,
      summary: `Check ${check.name} passed`,
      payload: { name: check.name, head },
      link: check.url ?? snapshot.url,
      dedupeKey: `check.passed/${head}/${check.name}`
    })
  }

  const required = current.filter((c) => c.required || snapshot.requiredChecks.includes(c.name))
  const requiredPassed = required.every((c) => c.outcome === "passed") &&
    snapshot.requiredChecks.every((name) => current.some((c) => c.name === name))
  const waiting = current.some((c) => c.outcome === "pending" && matchesAny(filters.readyWait, c.name))
  const approved = snapshot.reviewDecision === "APPROVED" || snapshot.reviewDecision === null
  const ready = snapshot.state === "OPEN" && !snapshot.isDraft && snapshot.mergeable === "MERGEABLE" && approved &&
    requiredPassed && !waiting
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
      threads: threads.mark,
      replies: replies.mark,
      requests: requests.mark,
      draft,
      checkPassed: [...checkPassed],
      pin,
      reviewer
    }
  }
}
