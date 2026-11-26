import { describe, expect, it } from "@effect/vitest"
import * as Cursor from "../src/Cursor.ts"
import { type Filters, step } from "../src/Diff.ts"
import * as Glob from "../src/Glob.ts"
import type { Release, Run, Snapshot } from "../src/Snapshot.ts"

const site = { web: "https://github.com", repository: "acme/api" }
const sha = (c: string) => c.repeat(40)

const filters = (f: Partial<Record<keyof Filters, ReadonlyArray<string>>>): Filters => ({
  tags: (f.tags ?? []).map(Glob.compile),
  branches: (f.branches ?? []).map(Glob.compile),
  releases: (f.releases ?? []).map(Glob.compile),
  workflows: f.workflows ?? []
})

const refs = (entries: Record<string, string>) => new Map(Object.entries(entries))

const snapshot = (s: {
  readonly tags?: Record<string, string>
  readonly branches?: Record<string, string>
  readonly releases?: ReadonlyArray<Release>
  readonly workflows?: Record<string, ReadonlyArray<Run> | null>
}): Snapshot => ({
  tags: s.tags === undefined ? null : refs(s.tags),
  branches: s.branches === undefined ? null : refs(s.branches),
  releases: s.releases ?? null,
  workflows: new Map(Object.entries(s.workflows ?? {}))
})

const release = (id: number, tag: string, publishedAt: string | null): Release => ({
  id,
  tag,
  name: null,
  prerelease: false,
  draft: publishedAt === null,
  publishedAt,
  url: `https://github.com/acme/api/releases/tag/${tag}`
})

const run = (id: number, completed: boolean, attempt = 1): Run => ({
  id,
  attempt,
  runNumber: id,
  name: "Publish",
  completed,
  conclusion: completed ? "success" : null,
  branch: "release/mic/4.45",
  sha: sha("c"),
  event: "workflow_dispatch",
  url: `https://github.com/acme/api/actions/runs/${id}`,
  updatedAt: "2026-11-26T00:00:00Z"
})

const keys = (result: { readonly events: ReadonlyArray<{ readonly dedupeKey: string }> }) =>
  result.events.map((e) => e.dedupeKey)

describe("glob", () => {
  it("matches * across slashes and ? as one character, and keeps the literal start", () => {
    const glob = Glob.compile("mic-lib-v4.45*")
    expect(glob.prefix).toBe("mic-lib-v4.45")
    expect(glob.regex.test("mic-lib-v4.45.0")).toBe(true)
    expect(glob.regex.test("mic-lib-v4x45.0")).toBe(false)
    expect(Glob.compile("release/*").regex.test("release/mic/4.45")).toBe(true)
    expect(Glob.compile("v1.?").regex.test("v1.2")).toBe(true)
    expect(Glob.compile("release/mic/4.45").regex.test("release/mic/4.450")).toBe(false)
  })
})

describe("step", () => {
  const f = filters({ tags: ["mic-lib-v4.45*"], branches: ["release/mic/*"] })

  it("takes the first poll as a silent baseline, then reports created, moved and deleted refs", () => {
    const first = step(undefined, snapshot({
      tags: { "mic-lib-v4.44.0": sha("1"), "mic-lib-v4.45.0-rc": sha("2") },
      branches: { "release/mic/4.44": sha("3"), "release/mic/4.45": sha("4"), main: sha("5") }
    }), f, site, "2026-11-26T10:00:00.000Z")
    expect(first.events).toEqual([])
    expect([...first.memory.tags!.refs]).toEqual([["mic-lib-v4.45.0-rc", sha("2")]])

    const second = step(first.memory, snapshot({
      tags: { "mic-lib-v4.45.0-rc": sha("6"), "mic-lib-v4.45.0": sha("7") },
      branches: { "release/mic/4.45": sha("8"), "release/mic/4.46": sha("9"), main: sha("a") }
    }), f, site, "2026-11-26T10:01:00.000Z")
    expect(keys(second)).toEqual([
      `tag.moved/mic-lib-v4.45.0-rc/${sha("6")}`,
      `tag.created/mic-lib-v4.45.0/${sha("7")}`,
      `branch.moved/release/mic/4.45/${sha("8")}`,
      `branch.created/release/mic/4.46/${sha("9")}`,
      `branch.deleted/release/mic/4.44/${sha("3")}`
    ])
    expect(second.events[1]).toMatchObject({
      type: "tag.created",
      payload: { name: "mic-lib-v4.45.0", sha: sha("7") },
      link: "https://github.com/acme/api/tree/mic-lib-v4.45.0"
    })
    expect(step(second.memory, snapshot({
      tags: { "mic-lib-v4.45.0-rc": sha("6"), "mic-lib-v4.45.0": sha("7") },
      branches: { "release/mic/4.45": sha("8"), "release/mic/4.46": sha("9") }
    }), f, site, "2026-11-26T10:02:00.000Z").events).toEqual([])
  })

  it("treats ref names such as constructor and __proto__ as names, through the cursor too", () => {
    const all = filters({ branches: ["*"] })
    const first = step(undefined, snapshot({ branches: JSON.parse(`{"__proto__":"${sha("1")}"}`) }), all, site, "t")
    const resumed = Cursor.decode(Cursor.encode(first.memory))
    expect([...resumed!.branches!.refs]).toEqual([["__proto__", sha("1")]])

    const second = step(resumed, snapshot({ branches: { constructor: sha("2") } }), all, site, "t")
    expect(keys(second)).toEqual([`branch.created/constructor/${sha("2")}`, `branch.deleted/__proto__/${sha("1")}`])
    expect(keys(step(second.memory, snapshot({ branches: {} }), all, site, "t"))).toEqual([
      `branch.deleted/constructor/${sha("2")}`
    ])
  })

  it("takes a fresh silent baseline when the patterns change", () => {
    const first = step(undefined, snapshot({ tags: { "v1": sha("1") } }), filters({ tags: ["v1*"] }), site, "t")
    const changed = step(first.memory, snapshot({ tags: { "v1": sha("1"), "v2": sha("2") } }), filters({ tags: ["v*"] }), site, "t")
    expect(changed.events).toEqual([])
    expect(changed.memory.tags?.patterns).toEqual(["v*"])
    const reordered = step(
      step(undefined, snapshot({ tags: { "v1": sha("1") } }), filters({ tags: ["v*", "w*"] }), site, "t").memory,
      snapshot({ tags: { "v1": sha("1"), "w1": sha("2") } }),
      filters({ tags: ["w*", "v*"] }),
      site,
      "t"
    )
    expect(keys(reordered)).toEqual([`tag.created/w1/${sha("2")}`])
  })

  it("reports a release published after the last poll, a draft created before it too, and not one a deletion uncovers", () => {
    const rf = filters({ releases: ["mic-lib-*"] })
    const first = step(undefined, snapshot({
      releases: [release(200, "mic-lib-v4.44.1", "2026-11-20T00:00:00Z"), release(150, "mic-lib-v4.44.0", "2026-11-10T00:00:00Z")]
    }), rf, site, "t")
    expect(first.events).toEqual([])

    const second = step(first.memory, snapshot({
      releases: [
        release(300, "mic-lib-v4.45.1", "2026-11-26T00:05:00Z"),
        release(250, "other-v1", "2026-11-26T00:00:00Z"),
        release(200, "mic-lib-v4.44.1", "2026-11-20T00:00:00Z"),
        release(100, "mic-lib-v4.45.0", "2026-11-26T00:00:00Z"),
        release(90, "mic-lib-v4.43.0", "2026-11-01T00:00:00Z")
      ]
    }), rf, site, "t")
    expect(keys(second)).toEqual(["release.published/100", "release.published/300"])
    expect(second.events[0]).toMatchObject({ occurredAt: "2026-11-26T00:00:00Z", payload: { tag: "mic-lib-v4.45.0" } })

    const tie = step(second.memory, snapshot({
      releases: [release(310, "mic-lib-v4.45.2", "2026-11-26T00:05:00Z"), release(300, "mic-lib-v4.45.1", "2026-11-26T00:05:00Z")]
    }), rf, site, "t")
    expect(keys(tie)).toEqual(["release.published/310"])
  })

  it("reports a run when it starts and when it completes, once per attempt, and keeps the list GitHub did not change", () => {
    const wf = filters({ workflows: ["mic-release-publish.yaml"] })
    const at = (runs: ReadonlyArray<Run> | null) => snapshot({ workflows: { "mic-release-publish.yaml": runs } })
    const first = step(undefined, at([run(10, true)]), wf, site, "t")
    expect(first.events).toEqual([])
    const unchanged = step(first.memory, at(null), wf, site, "t")
    expect(unchanged.memory).toEqual(first.memory)

    const started = step(unchanged.memory, at([run(11, false), run(10, true)]), wf, site, "t")
    expect(keys(started)).toEqual(["workflow.started/11/1"])
    const finished = step(started.memory, at([run(11, true), run(10, true)]), wf, site, "t")
    expect(keys(finished)).toEqual(["workflow.completed/11/1"])
    expect(finished.events[0]).toMatchObject({
      summary: "Publish run #11 on release/mic/4.45 finished: success",
      payload: { workflow: "mic-release-publish.yaml", conclusion: "success", runId: 11 }
    })
    expect(keys(step(finished.memory, at([run(12, true), run(11, true, 2), run(9, true)]), wf, site, "t"))).toEqual([
      "workflow.completed/11/2",
      "workflow.completed/12/1"
    ])
  })

  it("keeps its memory through the cursor, and starts a new baseline from a cursor it cannot read", () => {
    const memory = step(undefined, snapshot({
      tags: { "v1": sha("1") },
      releases: [release(3, "v1", null)],
      workflows: { "a.yaml": [run(1, false)] }
    }), filters({ tags: ["v*"], releases: ["*"], workflows: ["a.yaml"] }), site, "t").memory
    expect(Cursor.encode(memory)).toContain(`"v":1`)
    expect(Cursor.decode(Cursor.encode(memory))).toEqual(memory)
    expect(Cursor.decode(`{"v":9}`)).toBeUndefined()
  })
})
