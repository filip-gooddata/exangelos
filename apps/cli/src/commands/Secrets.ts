import { Effect, FileSystem, Redacted, Stream } from "effect"
import { Prompt } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { InputInvalid, pairs } from "./Input.ts"

/** Where one secret field's value comes from. The value itself never appears on the command line. */
export type SecretSource =
  | { readonly _tag: "Command"; readonly key: string; readonly command: string }
  | { readonly _tag: "File"; readonly key: string; readonly path: string }
  | { readonly _tag: "Prompt"; readonly key: string }

/** Collects `--secret-command key=<command>`, `--secret-file key=<path>` and `--secret-prompt key`. */
export const sources = (flags: {
  readonly commands: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
  readonly prompts: ReadonlyArray<string>
}): Effect.Effect<Array<SecretSource>, InputInvalid> =>
  Effect.gen(function*() {
    const commands = Object.entries(yield* pairs(flags.commands)).map(([key, command]) =>
      ({ _tag: "Command", key, command }) as const
    )
    const files = Object.entries(yield* pairs(flags.files)).map(([key, path]) => ({ _tag: "File", key, path }) as const)
    const prompts = flags.prompts.map((key) => ({ _tag: "Prompt", key }) as const)
    const all: Array<SecretSource> = [...commands, ...files, ...prompts]
    const seen = new Set<string>()
    for (const source of all) {
      if (seen.has(source.key)) {
        return yield* new InputInvalid({ message: `The secret field "${source.key}" has two sources. Give it one.` })
      }
      seen.add(source.key)
    }
    return all
  })

const withoutFinalNewline = (text: string): string => text.replace(/\r?\n$/, "")

const fromCommand = (source: { readonly key: string; readonly command: string }) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", source.command]))
    const [output, , exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 3 }
    )
    if (exitCode !== 0) {
      return yield* new InputInvalid({
        message: `The command for the secret field "${source.key}" exited with code ${exitCode}. Run it by hand to check it prints the secret, then retry.`
      })
    }
    return withoutFinalNewline(output)
  })).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        new InputInvalid({
          message: `The command for the secret field "${source.key}" could not run. Check it runs in sh, then retry.`
        })
      ))
  )

const fromFile = (source: { readonly key: string; readonly path: string }) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(source.path)).pipe(
    Effect.map(withoutFinalNewline),
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        new InputInvalid({
          message: `The file for the secret field "${source.key}" could not be read: ${source.path}. Check the path and its permissions, then retry.`
        })
      ))
  )

const fromPrompt = (source: { readonly key: string }, label: string) =>
  Prompt.Hidden({ message: `${label} (${source.key})` }).pipe(
    Effect.map(Redacted.value),
    Effect.catchTag("QuitError", () =>
      Effect.fail(new InputInvalid({ message: `No value was entered for the secret field "${source.key}".` })))
  )

/** Replaces every secret value inside the string fields of `failure`, so an echoed value never gets printed. */
export const scrub = <F extends object>(failure: F, values: ReadonlyArray<string>): F => {
  const clean = (text: string) => values.reduce((acc, value) => acc.split(value).join("[secret]"), text)
  const fields = Object.fromEntries(
    Object.entries(failure).map(([key, field]) => [key, typeof field === "string" ? clean(field) : field])
  )
  return Object.assign(Object.create(Object.getPrototypeOf(failure)), failure, fields)
}

/**
 * Reads each secret once. The values stay redacted until the caller hands them to the daemon,
 * and no error names a value.
 */
export const read = (
  all: ReadonlyArray<SecretSource>,
  label: (key: string) => string
) =>
  Effect.forEach(all, (source) => {
    const value: Effect.Effect<
      string,
      InputInvalid,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Prompt.Environment
    > = source._tag === "Command"
      ? fromCommand(source)
      : source._tag === "File"
      ? fromFile(source)
      : fromPrompt(source, label(source.key))
    return Effect.flatMap(value, (text) =>
      text.length === 0
        ? Effect.fail(new InputInvalid({ message: `The secret field "${source.key}" came out empty. Check its source.` }))
        : Effect.succeed([source.key, Redacted.make(text)] as const))
  })
