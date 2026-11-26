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

const snapshot = (s: Partial<Snapshot>): Snapshot => ({ tags: null, branches: null, releases: null, workflows: {}, ...s })

const release = (id: string, tag: string, publishedAt: string | null, draft = false): Release => ({
  id,
  tag,
  name: null,
  prerelease: false,
  draft,
  publishedAt,
  url: `https://github.com/acme/api/releases/tag/${tag}`
})

const run = (id: number, updatedAt: string, attempt = 1): Run => ({
  id,
  attempt,
  runNumber: id,
  name: "Publish",
  conclusion: "success",
  branch: "release/mic/4.45",
  sha: sha("c"),
  event: "workflow_dispatch",
  url: `https://github.com/acme/api/actions/runs/${id}`,
  updatedAt
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
    expect(first.memory.tags?.refs).toEqual({ "mic-lib-v4.45.0-rc": sha("2") })

    const second = step(first.memory, snapshot({
      tags: { "mic-lib-v4.45.0-rc": sha("6"), "mic-lib-v4.45.0": sha("7") },
      branches: { "release/mic/4.45": sha("8"), "release/mic/4.46": sha("9"), main: sha("a") }
    }), f, site, "2026-11-26T10:01:00.000Z")
    expect(keys(second)).toEqual([
      `tag.moved/mic-lib-v4.45.0-rc/${sha("2")}/${sha("6")}`,
      `tag.created/mic-lib-v4.45.0/${sha("7")}`,
      `branch.moved/release/mic/4.45/${sha("4")}/${sha("8")}`,
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

  it("takes a fresh silent baseline when the patterns change", () => {
    const first = step(undefined, snapshot({ tags: { "v1": sha("1") } }), filters({ tags: ["v1*"] }), site, "t")
    const changed = step(first.memory, snapshot({ tags: { "v1": sha("1"), "v2": sha("2") } }), filters({ tags: ["v*"] }), site, "t")
    expect(changed.events).toEqual([])
    expect(changed.memory.tags).toEqual({ patterns: ["v*"], refs: { "v1": sha("1"), "v2": sha("2") } })
  })

  it("reports a published release once, skipping drafts and releases that slide into the window", () => {
    const rf = filters({ releases: ["mic-lib-*"] })
    const first = step(undefined, snapshot({
      releases: [release("R3", "mic-lib-v4.44.1", "2026-11-20T00:00:00Z"), release("R2", "mic-lib-v4.44.0", "2026-11-10T00:00:00Z")]
    }), rf, site, "t")
    expect(first.events).toEqual([])

    const second = step(first.memory, snapshot({
      releases: [
        release("R5", "mic-lib-v4.45.0", null, true),
        release("R4", "mic-lib-v4.45.0", "2026-11-26T00:00:00Z"),
        release("R9", "other-v1", "2026-11-26T00:00:00Z"),
        release("R3", "mic-lib-v4.44.1", "2026-11-20T00:00:00Z"),
        release("R1", "mic-lib-v4.43.0", "2026-11-01T00:00:00Z")
      ]
    }), rf, site, "t")
    expect(keys(second)).toEqual(["release.published/R4"])
    expect(second.events[0]).toMatchObject({ occurredAt: "2026-11-26T00:00:00Z", payload: { tag: "mic-lib-v4.45.0" } })
  })

  it("reports each completed run attempt once, and keeps the last list when GitHub says it did not change", () => {
    const wf = filters({ workflows: ["mic-release-publish.yaml"] })
    const first = step(undefined, snapshot({ workflows: { "mic-release-publish.yaml": [run(10, "2026-11-25T00:00:00Z")] } }), wf, site, "t")
    expect(first.events).toEqual([])
    const unchanged = step(first.memory, snapshot({ workflows: { "mic-release-publish.yaml": null } }), wf, site, "t")
    expect(unchanged.memory).toEqual(first.memory)

    const second = step(unchanged.memory, snapshot({
      workflows: {
        "mic-release-publish.yaml": [run(11, "2026-11-26T00:00:00Z"), run(10, "2026-11-26T00:05:00Z", 2)]
      }
    }), wf, site, "t")
    expect(keys(second)).toEqual(["workflow.completed/10/2", "workflow.completed/11/1"])
    expect(second.events[1]).toMatchObject({
      summary: "Publish run #11 on release/mic/4.45 finished: success",
      payload: { workflow: "mic-release-publish.yaml", conclusion: "success", runId: 11 }
    })
  })

  it("keeps its memory through the cursor, and starts a new baseline from a cursor it cannot read", () => {
    const memory = step(undefined, snapshot({ tags: { "v1": sha("1") }, workflows: { "a.yaml": [run(1, "x")] } }),
      filters({ tags: ["v*"], workflows: ["a.yaml"] }), site, "t").memory
    expect(Cursor.encode(memory)).toContain(`"v":1`)
    expect(Cursor.decode(Cursor.encode(memory))).toEqual(memory)
    expect(Cursor.decode(`{"v":9}`)).toBeUndefined()
  })
})
