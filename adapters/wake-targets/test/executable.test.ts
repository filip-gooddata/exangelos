import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { WakeTarget } from "@exangelos/application"
import { layerSettingsStore } from "@exangelos/application/testing"
import { Executable, layer } from "../src/index.ts"
import { content, recordingSpawner } from "./fixtures.ts"

/** The PATH a Homebrew service gets on Apple silicon. */
const servicePath = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

const lookup = (files: ReadonlyArray<string>, directories: Record<string, ReadonlyArray<string>> = {}): Executable.Lookup => ({
  path: servicePath,
  home: "/Users/owner",
  isExecutable: (file) => files.includes(file),
  listDirectory: (directory) => directories[directory] ?? []
})

describe("finding a harness CLI", () => {
  it("finds one in a user directory the service PATH lacks, and puts that directory first on its PATH", () => {
    const located = Executable.locate({ program: "t3", args: ["thread"] }, lookup(["/Users/owner/.local/bin/t3"]))
    expect(located).toEqual({
      program: "/Users/owner/.local/bin/t3",
      args: ["thread"],
      env: { PATH: `/Users/owner/.local/bin:${servicePath}` }
    })
  })

  it("prefers the daemon's PATH, then the newest nvm node", () => {
    const nvm = { "/Users/owner/.nvm/versions/node": ["v9.11.2", "v22.3.0", "v20.18.1"] }
    expect(Executable.resolve("codex", lookup(["/usr/bin/codex", "/Users/owner/.local/bin/codex"]))).toEqual({ _tag: "Found", file: "/usr/bin/codex" })
    expect(Executable.resolve("codex", lookup(["/Users/owner/.nvm/versions/node/v20.18.1/bin/codex", "/Users/owner/.nvm/versions/node/v22.3.0/bin/codex"], nvm)))
      .toEqual({ _tag: "Found", file: "/Users/owner/.nvm/versions/node/v22.3.0/bin/codex" })
  })

  it("takes a program with a slash as given", () => {
    const invocation = { program: "/opt/relay", args: [] }
    expect(Executable.locate(invocation, lookup([]))).toBe(invocation)
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
      expect(reason).toContain("/Users/owner/.local/bin, /Users/owner/bin, /Users/owner/.bun/bin")
    }))
})
