import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Keychain } from "../src/index.ts"
import * as FakeSpawner from "./FakeSpawner.ts"

const entry = { service: "exangelos.github", account: "token" }
const secret = "ghp-s3cr\"et"
const secretHex = "6768702d73336372226574"

const keychain = (layer: Layer.Layer<Keychain.Keychain, never, ChildProcessSpawner.ChildProcessSpawner>, reply: Parameters<typeof FakeSpawner.make>[0]) => {
  const fake = FakeSpawner.make(reply)
  return { calls: fake.calls, provide: Effect.provide(layer.pipe(Layer.provide(fake.layer))) }
}

const service = Keychain.Keychain

const noArgumentHolds = (calls: ReadonlyArray<FakeSpawner.Call>, value: string) =>
  calls.every((call) => call.args.every((arg) => !arg.includes(value)))

describe("macOS Keychain", () => {
  it.effect("adds a password through security's stdin, hex-encoded", () => {
    const { calls, provide } = keychain(Keychain.macOS, () => ({}))
    return Effect.gen(function*() {
      yield* (yield* service).set(entry, Redacted.make(secret))
      expect(calls).toEqual([{
        command: "security",
        args: ["-i"],
        stdin: `add-generic-password -U -a "token" -s "exangelos.github" -X ${secretHex}\n`
      }])
      expect(noArgumentHolds(calls, secret)).toBe(true)
      expect(calls[0]!.stdin).not.toContain(secret)
    }).pipe(provide)
  })

  it.effect("reads a password and reports a missing one as none", () => {
    const { calls, provide } = keychain(
      Keychain.macOS,
      (call) => call.args.includes("missing") ? { exitCode: 44, stderr: "The specified item could not be found" } : { stdout: `${secret}\n` }
    )
    return Effect.gen(function*() {
      const keychain = yield* service
      expect(Option.map(yield* keychain.get(entry), Redacted.value)).toEqual(Option.some(secret))
      expect(yield* keychain.get({ ...entry, account: "missing" })).toEqual(Option.none())
      expect(calls[0]!.args).toEqual(["find-generic-password", "-a", "token", "-s", "exangelos.github", "-w"])
    }).pipe(provide)
  })

  it.effect("deletes an entry and skips a missing one", () => {
    const { calls, provide } = keychain(Keychain.macOS, (call) => call.args.includes("missing") ? { exitCode: 44 } : {})
    return Effect.gen(function*() {
      const keychain = yield* service
      yield* keychain.delete(entry)
      yield* keychain.delete({ ...entry, account: "missing" })
      expect(calls[0]!.args).toEqual(["delete-generic-password", "-a", "token", "-s", "exangelos.github"])
    }).pipe(provide)
  })

  it.effect("fails with the exit status and never the secret", () => {
    const { provide } = keychain(Keychain.macOS, () => ({ exitCode: 51, stderr: `unknown command ${secretHex} ${secret}` }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip((yield* service).set(entry, Redacted.make(secret)))
      expect(error).toMatchObject({ _tag: "KeychainFailed", store: "macOS Keychain", operation: "set" })
      expect(error.reason).toContain("51")
      expect(error.reason).not.toContain(secret)
      expect(error.reason).not.toContain(secretHex)
    }).pipe(provide)
  })

  it.effect("refuses a secret security cannot store or return intact, before running it", () => {
    const { calls, provide } = keychain(Keychain.macOS, () => ({}))
    return Effect.gen(function*() {
      const keychain = yield* service
      const unicode = yield* Effect.flip(keychain.set(entry, Redacted.make("pässword")))
      const long = yield* Effect.flip(keychain.set(entry, Redacted.make("x".repeat(2100))))
      expect([unicode._tag, long._tag]).toEqual(["KeychainFailed", "KeychainFailed"])
      expect(calls).toEqual([])
    }).pipe(provide)
  })
})

describe("Secret Service", () => {
  it.effect("stores a password through secret-tool's stdin", () => {
    const { calls, provide } = keychain(Keychain.secretService, () => ({}))
    return Effect.gen(function*() {
      yield* (yield* service).set(entry, Redacted.make(secret))
      expect(calls).toEqual([{
        command: "secret-tool",
        args: ["store", "--label=exangelos.github token", "service", "exangelos.github", "account", "token"],
        stdin: secret
      }])
      expect(noArgumentHolds(calls, secret)).toBe(true)
    }).pipe(provide)
  })

  it.effect("reads a password and reports a missing one as none", () => {
    const { calls, provide } = keychain(
      Keychain.secretService,
      (call) => call.args.includes("missing") ? { exitCode: 1 } : { stdout: secret }
    )
    return Effect.gen(function*() {
      const keychain = yield* service
      expect(Option.map(yield* keychain.get(entry), Redacted.value)).toEqual(Option.some(secret))
      expect(yield* keychain.get({ ...entry, account: "missing" })).toEqual(Option.none())
      expect(calls[0]!.args).toEqual(["lookup", "service", "exangelos.github", "account", "token"])
    }).pipe(provide)
  })

  it.effect("deletes an entry and skips a missing one", () => {
    const { calls, provide } = keychain(Keychain.secretService, (call) => call.args.includes("missing") ? { exitCode: 1 } : {})
    return Effect.gen(function*() {
      const keychain = yield* service
      yield* keychain.delete(entry)
      yield* keychain.delete({ ...entry, account: "missing" })
      expect(calls[0]!.args).toEqual(["clear", "service", "exangelos.github", "account", "token"])
    }).pipe(provide)
  })

  it.effect("fails when the service answers with an error", () => {
    const { provide } = keychain(Keychain.secretService, () => ({ exitCode: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip((yield* service).get(entry))
      expect(error).toMatchObject({ _tag: "KeychainFailed", store: "Secret Service", operation: "get" })
      expect(error.reason).toContain("D-Bus")
    }).pipe(provide)
  })
})

describe("detect", () => {
  const detect = (platform: string, reply: Parameters<typeof FakeSpawner.make>[0]) => {
    const fake = FakeSpawner.make(reply)
    return Keychain.detect(platform).pipe(Effect.provide(fake.layer))
  }

  it.effect("picks the store a machine has", () =>
    Effect.gen(function*() {
      expect(yield* detect("darwin", () => "missing")).toEqual(Option.some("macOS Keychain"))
      expect(yield* detect("linux", () => ({ exitCode: 1 }))).toEqual(Option.some("Secret Service"))
      expect(yield* detect("linux", () => "missing")).toEqual(Option.none())
      expect(yield* detect("linux", () => ({ exitCode: 1, stderr: "Cannot autolaunch D-Bus" }))).toEqual(Option.none())
    }))
})
