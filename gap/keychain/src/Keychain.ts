import { Context, Effect, Layer, Option, Redacted, Result, Schema, Stream } from "effect"
import { Hex } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface Entry {
  readonly service: string
  readonly account: string
}

export const Store = Schema.Literals(["macOS Keychain", "Secret Service"])
export type Store = typeof Store.Type

export class KeychainFailed extends Schema.TaggedError<KeychainFailed>()("KeychainFailed", {
  store: Store,
  operation: Schema.Literals(["set", "get", "delete"]),
  reason: Schema.String
}) {}

export class Keychain extends Context.Service<Keychain, {
  readonly store: Store
  readonly set: (entry: Entry, secret: Redacted.Redacted<string>) => Effect.Effect<void, KeychainFailed>
  readonly get: (entry: Entry) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainFailed>
  readonly delete: (entry: Entry) => Effect.Effect<void, KeychainFailed>
}>()("@exangelos/keychain/Keychain") {}

interface Outcome {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const bytes = (text: string) =>
  Stream.make(text).pipe(
    Stream.encodeText,
    Stream.runCollect,
    Effect.map((chunks) => chunks.flatMap((chunk) => Array.from(chunk)))
  )

const run = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], command: string, args: ReadonlyArray<string>, stdin?: string) =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
      stdin: stdin === undefined ? "ignore" : Stream.encodeText(Stream.make(stdin))
    }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { exitCode, stdout, stderr } satisfies Outcome
  }))

const reasonOf = (command: string, outcome: Outcome) =>
  `${command} exited with ${outcome.exitCode}${outcome.stderr.trim() === "" ? "" : `: ${outcome.stderr.trim()}`}`

const exitedWith = (command: string, outcome: Outcome) => `${command} exited with ${outcome.exitCode}`

const quote = (word: string) => `"${word.replace(/[\\"]/g, (character) => `\\${character}`)}"`

const macOSNotFound = 44

// security find-generic-password -g prints the password to stderr as `password: "text"` when every byte is printable
// ASCII and as `password: 0x<hex>  "escaped"` otherwise, so the stored bytes come back exactly either way.
const passwordOf = (stderr: string): Option.Option<string> => {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("password: "))
  if (line === undefined) return Option.none()
  const shown = line.slice("password: ".length)
  if (shown === "") return Option.some("")
  const hex = /^0x([0-9A-Fa-f]*)(\s|$)/.exec(shown)
  if (hex !== null) return Result.getSuccess(Hex.decodeString(hex[1]!))
  return shown.length >= 2 && shown.startsWith("\"") && shown.endsWith("\"") ? Option.some(shown.slice(1, -1)) : Option.none()
}

// security -i reads lines into a 4096 byte buffer, NUL included, and runs any overflow as a further command.
const securityLineLimit = 4095

export const macOS: Layer.Layer<Keychain, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(Keychain)(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const store = "macOS Keychain"
    const fail = (operation: KeychainFailed["operation"]) => (reason: string) =>
      new KeychainFailed({ store, operation, reason })
    return {
      store,
      set: (entry, secret) =>
        Effect.gen(function*() {
          const value = Redacted.value(secret)
          if (/[\0\r\n]/.test(entry.account + entry.service)) {
            return yield* fail("set")("the entry name holds a line break or NUL")
          }
          const hex = (yield* bytes(value)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
          const line = `add-generic-password -U -a ${quote(entry.account)} -s ${quote(entry.service)} -X ${hex}\n`
          if ((yield* bytes(line)).length > securityLineLimit) {
            return yield* fail("set")("the secret is too long for security's input line")
          }
          const outcome = yield* run(spawner, "security", ["-i"], line).pipe(Effect.mapError(() => fail("set")("security could not start")))
          if (outcome.exitCode !== 0) return yield* fail("set")(exitedWith("security", outcome))
        }),
      get: (entry) =>
        Effect.gen(function*() {
          const outcome = yield* run(spawner, "security", ["find-generic-password", "-a", entry.account, "-s", entry.service, "-g"])
            .pipe(Effect.mapError((error) => fail("get")(error.message)))
          if (outcome.exitCode === macOSNotFound) return Option.none()
          if (outcome.exitCode !== 0) return yield* fail("get")(reasonOf("security", outcome))
          const value = passwordOf(outcome.stderr)
          if (Option.isNone(value)) return yield* fail("get")("security did not print the password in a known form")
          return Option.some(Redacted.make(value.value))
        }),
      delete: (entry) =>
        Effect.gen(function*() {
          const outcome = yield* run(spawner, "security", ["delete-generic-password", "-a", entry.account, "-s", entry.service])
            .pipe(Effect.mapError((error) => fail("delete")(error.message)))
          if (outcome.exitCode !== 0 && outcome.exitCode !== macOSNotFound) {
            return yield* fail("delete")(reasonOf("security", outcome))
          }
        })
    }
  })
)

const attributes = (entry: Entry) => ["service", entry.service, "account", entry.account]

export const secretService: Layer.Layer<Keychain, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(Keychain)(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const store = "Secret Service"
    const fail = (operation: KeychainFailed["operation"]) => (reason: string) =>
      new KeychainFailed({ store, operation, reason })
    return {
      store,
      set: (entry, secret) =>
        Effect.gen(function*() {
          const label = `--label=${entry.service} ${entry.account}`
          const outcome = yield* run(spawner, "secret-tool", ["store", label, ...attributes(entry)], Redacted.value(secret))
            .pipe(Effect.mapError(() => fail("set")("secret-tool could not start")))
          if (outcome.exitCode !== 0) return yield* fail("set")(exitedWith("secret-tool", outcome))
        }),
      get: (entry) =>
        Effect.gen(function*() {
          const outcome = yield* run(spawner, "secret-tool", ["lookup", ...attributes(entry)])
            .pipe(Effect.mapError((error) => fail("get")(error.message)))
          if (outcome.exitCode === 0) return Option.some(Redacted.make(outcome.stdout))
          if (outcome.exitCode === 1 && outcome.stderr.trim() === "") return Option.none()
          return yield* fail("get")(reasonOf("secret-tool", outcome))
        }),
      delete: (entry) =>
        Effect.gen(function*() {
          const outcome = yield* run(spawner, "secret-tool", ["clear", ...attributes(entry)])
            .pipe(Effect.mapError((error) => fail("delete")(error.message)))
          if (outcome.exitCode === 0 || (outcome.exitCode === 1 && outcome.stderr.trim() === "")) return
          return yield* fail("delete")(reasonOf("secret-tool", outcome))
        })
    }
  })
)

export const detect = (platform: string): Effect.Effect<Option.Option<Store>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (platform === "darwin") return Option.some<Store>("macOS Keychain")
    if (platform !== "linux") return Option.none()
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const probe = yield* run(spawner, "secret-tool", ["lookup", "exangelos-probe", "absent"]).pipe(Effect.option)
    const reached = Option.exists(probe, (outcome) => outcome.stderr.trim() === "" && (outcome.exitCode === 0 || outcome.exitCode === 1))
    return reached ? Option.some<Store>("Secret Service") : Option.none()
  })

export const layer = (store: Store): Layer.Layer<Keychain, never, ChildProcessSpawner.ChildProcessSpawner> =>
  store === "macOS Keychain" ? macOS : secretService
