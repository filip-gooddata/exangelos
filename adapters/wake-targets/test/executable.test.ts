import { describe, expect, it } from "@effect/vitest"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { WakeTarget } from "@exangelos/application"
import { layerSettingsStore } from "@exangelos/application/testing"
import { Executable, layer } from "../src/index.ts"
import { content, recordingSpawner } from "./fixtures.ts"

/** The PATH a Homebrew service gets on Apple silicon. */
const servicePath = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

const lookup = (
  files: ReadonlyArray<string>,
  directories: Record<string, ReadonlyArray<string>> = {},
  path = servicePath
): Executable.Lookup => ({
  path,
  home: "/Users/owner",
  platform: "darwin",
  isExecutable: (file) => files.includes(file),
  listDirectory: (directory) => directories[directory] ?? []
})

describe("finding a harness CLI", () => {
  it.effect("wakes one in a user directory the service PATH lacks, with that directory first on its PATH", () =>
    Effect.gen(function*() {
      const runner = yield* recordingSpawner({ exitCode: 0 })
      yield* Effect.gen(function*() {
        yield* (yield* WakeTarget.WakeTarget).deliver({ harness: "t3", sessionId: "t1" }, content)
      }).pipe(Effect.provide(layer({ lookup: () => lookup(["/Users/owner/.local/bin/t3"]) }).pipe(Layer.provide([runner.layer, layerSettingsStore()]))))
      expect((yield* runner.spawned).map((command) => command.program)).toEqual(["/Users/owner/.local/bin/t3"])
      const [env] = yield* runner.environments
      expect(String(env?.["PATH"]).startsWith(`/Users/owner/.local/bin:${servicePath}:/Users/owner/bin:`)).toBe(true)
    }))

  it("keeps the service PATH as it is for a program found on it, whatever the entry looks like", () => {
    expect(Executable.locate({ program: "t3", args: [] }, lookup(["/usr/bin/t3"]))).toEqual({ program: "/usr/bin/t3", args: [] })
    const trailing = lookup(["/relay/bin/t3"], {}, "/preferred/bin:/relay/bin/")
    expect(Executable.locate({ program: "t3", args: [] }, trailing)).toEqual({ program: "/relay/bin/t3", args: [] })
    const relative = lookup([join(process.cwd(), "relative-bin", "t3")], {}, "relative-bin:/usr/bin")
    expect(Executable.locate({ program: "t3", args: [] }, relative)).toEqual({ program: join(process.cwd(), "relative-bin", "t3"), args: [] })
    const throughLink = lookup(["/x/link/../bin/t3"], {}, "/x/link/../bin")
    expect(Executable.locate({ program: "t3", args: [] }, throughLink)).toEqual({ program: "/x/link/../bin/t3", args: [] })
  })

  it("skips an empty PATH entry, as the spawner does", () => {
    expect(Executable.locate({ program: "t3", args: [] }, lookup([`${process.cwd()}/t3`], {}, ":/usr/bin"))).toMatchObject({ _tag: "NotStarted" })
  })

  it("prefers the daemon's PATH, then the newest nvm node", () => {
    const nvm = { "/Users/owner/.nvm/versions/node": ["v9.11.2", "v22.3.0", "v20.18.1"] }
    expect(Executable.resolve("codex", lookup(["/usr/bin/codex", "/Users/owner/.local/bin/codex"]))).toEqual({ _tag: "Found", file: "/usr/bin/codex", onServicePath: true })
    expect(Executable.resolve("codex", lookup(["/Users/owner/.nvm/versions/node/v20.18.1/bin/codex", "/Users/owner/.nvm/versions/node/v22.3.0/bin/codex"], nvm)))
      .toEqual({ _tag: "Found", file: "/Users/owner/.nvm/versions/node/v22.3.0/bin/codex", onServicePath: false })
  })

  it("names the directories the lookup searched, though a directory listing changes after it", () => {
    const nvm = "/Users/owner/.nvm/versions/node"
    const listings = [["v20.0.0"], ["v22.0.0"]]
    const changing = { ...lookup([]), listDirectory: (directory: string) => directory === nvm ? listings.shift() ?? [] : [] }
    const located = Executable.locate({ program: "codex", args: [] }, changing)
    const reason = "reason" in located ? located.reason : ""
    expect(reason).toContain("~/.nvm/versions/node/v20.0.0/bin")
    expect(reason).not.toContain("v22.0.0")
  })

  it("runs a program given as a path as it is, with the service PATH first for an absolute one", () => {
    const relative = { program: "./relay", args: [] }
    expect(Executable.locate(relative, lookup([]))).toBe(relative)
    const located = Executable.locate({ program: "/opt/relay/bin/relay", args: [] }, lookup([]))
    expect(located).toMatchObject({ program: "/opt/relay/bin/relay" })
    const path = "env" in located ? located.env?.["PATH"] : undefined
    expect(path?.startsWith(`${servicePath}:/opt/relay/bin:/Users/owner/.local/bin:`)).toBe(true)
  })

  it.effect("fails the wake naming the program and every directory searched when it is nowhere", () =>
    Effect.gen(function*() {
      const runner = yield* recordingSpawner({ exitCode: 0 })
      const { reason } = yield* Effect.flip(
        Effect.gen(function*() {
          yield* (yield* WakeTarget.WakeTarget).deliver({ harness: "t3", sessionId: "t1" }, content)
        }).pipe(Effect.provide(layer({ lookup: () => lookup([]) }).pipe(Layer.provide([runner.layer, layerSettingsStore()]))))
      )
      expect(yield* runner.spawned).toEqual([])
      expect(reason).toContain("t3 could not start: no executable named t3 in /opt/homebrew/bin, /opt/homebrew/sbin, /usr/bin")
      expect(reason).toContain("/sbin, ~/.local/bin, ~/bin, ~/.bun/bin")
      expect(reason).not.toContain("linuxbrew")
      expect(reason).toMatch(/; link it into one of them, such as ~\/\.local\/bin$/)
    }))
})
