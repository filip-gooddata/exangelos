import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as Path from "node:path"
import { Read, Record } from "../src/index.ts"

const line = (t: string, msg: string, src: Record.Source = "daemon", ann?: { connector: string }) =>
  `${JSON.stringify({ t, level: "INFO", src, pid: 1, msg, ...(ann ? { ann } : {}) })}\n`

const temp = () => fs.mkdtempSync(Path.join(os.tmpdir(), "exangelos-read-"))

describe("Read", () => {
  it("reads spans and ISO times for --since", () => {
    const now = new Date("2026-11-19T12:00:00.000Z")
    expect(Read.duration("10m")).toEqual(Option.some(600_000))
    expect(Read.duration("2h")).toEqual(Option.some(7_200_000))
    expect(Read.duration("1d")).toEqual(Option.some(86_400_000))
    expect(Read.duration("ten minutes")).toEqual(Option.none())
    expect(Read.since("30s", now)).toEqual(Option.some(new Date("2026-11-19T11:59:30.000Z")))
    expect(Read.since("2026-11-18T08:00:00Z", now)).toEqual(Option.some(new Date("2026-11-18T08:00:00.000Z")))
    expect(Read.since("yesterday", now)).toEqual(Option.none())
    expect(Read.since("2026-13-45", now)).toEqual(Option.none())
  })

  it("merges sources and rotations by time, skips junk, and filters", () => {
    const dir = temp()
    fs.writeFileSync(Path.join(dir, "daemon.1.jsonl"), line("2026-11-19T10:00:00.000Z", "oldest"))
    fs.writeFileSync(
      Path.join(dir, "daemon.jsonl"),
      line("2026-11-19T10:00:02.000Z", "third", "daemon", { connector: "jira" }) + "not json\n"
    )
    fs.writeFileSync(Path.join(dir, "cli.jsonl"), line("2026-11-19T10:00:01.000Z", "second", "cli"))
    const all = new Read.Tail(dir, Record.sources).backlog()
    expect(all.map((record) => record.msg)).toEqual(["oldest", "second", "third"])
    const jira = all.filter((record) =>
      Record.matches(record, { connector: "jira", since: new Date("2026-11-19T10:00:01.000Z") })
    )
    expect(jira.map((record) => record.msg)).toEqual(["third"])
  })

  it("follows a file through rotation and picks up files that appear later", () => {
    const dir = temp()
    const current = Path.join(dir, "daemon.jsonl")
    fs.writeFileSync(current, line("2026-11-19T10:00:00.000Z", "before"))
    const tail = new Read.Tail(dir, ["daemon", "mcp"])
    expect(tail.backlog().map((record) => record.msg)).toEqual(["before"])
    fs.appendFileSync(current, line("2026-11-19T10:00:01.000Z", "late write"))
    fs.renameSync(current, Path.join(dir, "daemon.1.jsonl"))
    fs.writeFileSync(current, line("2026-11-19T10:00:02.000Z", "after rotation"))
    fs.writeFileSync(Path.join(dir, "mcp.jsonl"), line("2026-11-19T10:00:03.000Z", "new source", "mcp"))
    fs.appendFileSync(Path.join(dir, "mcp.jsonl"), "{\"partial\":")
    expect(tail.poll().map((record) => record.msg)).toEqual(["late write", "after rotation", "new source"])
    expect(tail.poll()).toEqual([])
  })

  it("reads every rotation it missed when the file rotated twice between polls", () => {
    const dir = temp()
    const current = Path.join(dir, "daemon.jsonl")
    fs.writeFileSync(current, line("2026-11-19T10:00:00.000Z", "seen"))
    const tail = new Read.Tail(dir, ["daemon"])
    tail.backlog()
    fs.appendFileSync(current, line("2026-11-19T10:00:01.000Z", "first unseen"))
    fs.renameSync(current, Path.join(dir, "daemon.1.jsonl"))
    fs.writeFileSync(current, line("2026-11-19T10:00:02.000Z", "second unseen"))
    fs.renameSync(Path.join(dir, "daemon.1.jsonl"), Path.join(dir, "daemon.2.jsonl"))
    fs.renameSync(current, Path.join(dir, "daemon.1.jsonl"))
    fs.writeFileSync(current, line("2026-11-19T10:00:03.000Z", "third unseen"))
    expect(tail.poll().map((record) => record.msg)).toEqual(["first unseen", "second unseen", "third unseen"])
  })
})
