import { Console, Duration, Effect, Option, Path, Redacted, Schema } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/cli"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { Plugin, Settings } from "@exangelos/domain"
import * as Text from "../render/Text.ts"
import { Connection } from "./Connection.ts"
import * as Input from "./Input.ts"
import { type Failure, Json, respond } from "./Output.ts"
import * as Secrets from "./Secrets.ts"

const command = WakeText.command

const nameArgument = Argument.String("name").pipe(Argument.withDescription("The plugin name"))

const findPlugin = (client: Connection["Service"], name: string) =>
  Effect.flatMap(client.ListPlugins(), (all) => {
    const found = all.find((plugin) => plugin.name === name)
    return found === undefined ? Effect.fail(new DaemonContract.PluginNotFound({ plugin: name })) : Effect.succeed(found)
  })

const isArchive = (path: string): boolean => /\.(tar\.gz|tgz|tar|zip)$/.test(path)

const importSource = (source: string, ref: Option.Option<string>) =>
  Effect.gen(function*() {
    if (Option.isSome(ref)) return DaemonContract.ImportSource.cases.GitRepository.make({ url: source, ref: ref.value })
    if (source.startsWith("https://")) return DaemonContract.ImportSource.cases.HttpsLink.make({ url: source })
    const path = (yield* Path.Path).resolve(source)
    return isArchive(path)
      ? DaemonContract.ImportSource.cases.ArchiveFile.make({ path })
      : DaemonContract.ImportSource.cases.Directory.make({ path })
  })

const importPlugin = Command.make(
  "import",
  {
    source: Argument.String("source").pipe(
      Argument.withDescription("An archive file, an https:// archive link, a directory, or a git URL with --ref")
    ),
    ref: Flag.String("ref").pipe(Flag.withDescription("Import the source as a git repository at this ref"), Flag.optional)
  },
  ({ ref, source }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(importSource(source, ref), (resolved) => client.ImportPlugin({ source: resolved }))
      yield* respond(work, {
        schema: Plugin.Plugin,
        text: (plugin) =>
          `${Text.plugin(plugin)}\n\n${plugin.name} is inert. Run \`${command} plugin enable ${plugin.name}\` after checking its origin and checksum.`
      })
    })
).pipe(Command.withDescription("Import a plugin; it lands inert"))

const enable = Command.make(
  "enable",
  {
    name: nameArgument,
    digest: Flag.String("digest").pipe(
      Flag.withDescription("Enable without asking, if the plugin's checksum is still this one"),
      Flag.optional
    )
  },
  ({ digest, name }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const json = yield* Json
      const work = Effect.gen(function*() {
        const plugin = yield* Effect.flatMap(Input.pluginName(name), (valid) => findPlugin(client, valid))
        if (Option.isSome(digest)) return yield* client.EnablePlugin({ name: plugin.name, digest: digest.value })
        if (json) {
          return yield* new Input.InputInvalid({
            message: `Check the origin (${Text.origin(plugin.origin)}) and checksum (${plugin.digest}) of ${plugin.name}, then run \`${command} plugin enable ${plugin.name} --digest ${plugin.digest}\`.`
          })
        }
        yield* Console.log(`Origin:    ${Text.origin(plugin.origin)}\nChecksum:  ${plugin.digest}`)
        const confirmed = yield* Prompt.Confirm({ message: `Enable ${plugin.name}?` }).pipe(
          Effect.catchTag("QuitError", () => Effect.succeed(false))
        )
        if (!confirmed) {
          return yield* new Input.InputInvalid({ message: `${plugin.name} was not enabled. It stays inert.` })
        }
        return yield* client.EnablePlugin({ name: plugin.name, digest: plugin.digest })
      })
      yield* respond(work, { schema: Plugin.Plugin, text: (plugin) => `${plugin.name} is ${plugin.trust}.` })
    })
).pipe(Command.withDescription("Enable a plugin after showing its origin and checksum"))

const byName = <A, E extends Failure>(
  name: string,
  description: string,
  call: (client: Connection["Service"], name: Plugin.Plugin["name"]) => Effect.Effect<A, E>,
  schema: Schema.Codec<A, unknown>,
  text: (value: A, name: string) => string
) =>
  Command.make(name, { name: nameArgument }, (input) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(Input.pluginName(input.name), (valid) => call(client, valid))
      yield* respond(work, { schema, text: (value) => text(value, input.name) })
    })).pipe(Command.withDescription(description))

const disable = byName(
  "disable",
  "Disable a plugin; its subscriptions are suspended",
  (client, name) => client.DisablePlugin({ name }),
  Plugin.Plugin,
  (plugin) => `${plugin.name} is ${plugin.trust}.`
)

const remove = byName(
  "remove",
  "Remove a plugin",
  (client, name) => client.RemovePlugin({ name }),
  Schema.Void,
  (_, name) => `${name} was removed.`
)

const devUnlink = byName(
  "dev-unlink",
  "Remove a dev link",
  (client, name) => client.DevUnlink({ name }),
  Schema.Void,
  (_, name) => `${name} is no longer linked.`
)

const devLink = Command.make(
  "dev-link",
  { path: Argument.String("path").pipe(Argument.withDescription("The plugin's working directory")) },
  ({ path }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const absolute = (yield* Path.Path).resolve(path)
      yield* respond(client.DevLink({ path: absolute }), {
        schema: Plugin.Plugin,
        text: (plugin) => `${plugin.name} runs from ${absolute} as dev and restarts when its files change.`
      })
    })
).pipe(Command.withDescription("Trust a plugin working directory for development"))

const secretFieldKeys = (plugin: Plugin.Plugin): Set<string> =>
  new Set(
    (plugin.catalogue?.configuration ?? [])
      .filter((field) => field._tag === "Secret" || field.secretDestination)
      .map((field) => field.key)
  )

const configure = Command.make(
  "configure",
  {
    name: nameArgument,
    values: Argument.String("key=value").pipe(
      Argument.withDescription("Plain configuration fields, each as key=value"),
      Argument.variadic()
    ),
    secretCommands: Flag.String("secret-command").pipe(
      Flag.withDescription("key=<shell command>: read a secret field from what the command prints"),
      Flag.atLeast(0)
    ),
    secretFiles: Flag.String("secret-file").pipe(
      Flag.withDescription("key=<path>: read a secret field from a file"),
      Flag.atLeast(0)
    ),
    secretPrompts: Flag.String("secret-prompt").pipe(
      Flag.withDescription("key: ask for a secret field without echoing it"),
      Flag.atLeast(0)
    )
  },
  (input) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.gen(function*() {
        const name = yield* Input.pluginName(input.name)
        const plain = yield* Input.pairs(input.values)
        const sources = yield* Secrets.sources({
          commands: input.secretCommands,
          files: input.secretFiles,
          prompts: input.secretPrompts
        })
        const plugin = yield* findPlugin(client, name)
        const secretKeys = secretFieldKeys(plugin)
        const leaked = Object.keys(plain).filter((key) => secretKeys.has(key))
        if (leaked.length > 0) {
          return yield* new Input.InputInvalid({
            message: `${leaked.join(", ")} ${leaked.length === 1 ? "is a secret field" : "are secret fields"}, so ${
              leaked.length === 1 ? "it" : "they"
            } cannot be given as key=value. Nothing was sent. Use --secret-file, --secret-command or --secret-prompt.`
          })
        }
        const doubled = sources.filter((source) => Object.hasOwn(plain, source.key))
        if (doubled.length > 0) {
          return yield* new Input.InputInvalid({
            message: `${doubled.map((source) => source.key).join(", ")} is given both as key=value and as a secret. Give it once.`
          })
        }
        const labels = new Map((plugin.catalogue?.configuration ?? []).map((field) => [field.key, field.label]))
        const secrets = yield* Secrets.read(sources, (key) => labels.get(key) ?? key)
        const values: Record<string, string> = { ...plain }
        for (const [key, value] of secrets) values[key] = Redacted.value(value)
        const revealed = secrets.map(([, value]) => Redacted.value(value))
        return yield* client.ConfigurePlugin({ name, values }).pipe(
          Effect.mapError((failure) => Secrets.scrub(failure, revealed))
        )
      })
      yield* respond(work, {
        schema: Plugin.Plugin,
        text: (plugin) => `${plugin.name} is configured.`
      })
    })
).pipe(Command.withDescription("Configure a plugin; secret fields come from a command, a file or a hidden prompt"))

/** The `plugin` subcommands; the entry point adds `scaffold`. */
export const pluginCommands = [importPlugin, enable, disable, remove, configure, devLink, devUnlink] as const

const SettingsJson = Schema.toCodecJson(Settings.Settings)

const setPath = (encoded: unknown, path: ReadonlyArray<string>, value: string): Effect.Effect<unknown, Input.InputInvalid> => {
  const [head, ...rest] = path
  const unknownKey = new Input.InputInvalid({
    message: `There is no setting ${path.join(".")}. Run \`${command} settings\` to see the setting names.`
  })
  if (head === undefined || typeof encoded !== "object" || encoded === null) return Effect.fail(unknownKey)
  const current: Record<string, unknown> = { ...encoded }
  if (rest.length > 0) {
    return Object.hasOwn(current, head)
      ? Effect.map(setPath(current[head], rest, value), (inner) => ({ ...current, [head]: inner }))
      : Effect.fail(unknownKey)
  }
  const existing = current[head]
  if (typeof existing === "boolean") return Effect.succeed({ ...current, [head]: value === "true" ? true : value === "false" ? false : value })
  if (typeof existing === "number") {
    const number = Number(value)
    if (value.trim() !== "" && Number.isFinite(number)) return Effect.succeed({ ...current, [head]: number })
    const duration = Duration.fromInput(value as Duration.Input)
    return Option.isSome(duration)
      ? Effect.succeed({ ...current, [head]: Duration.toMillis(duration.value) })
      : Effect.succeed({ ...current, [head]: value })
  }
  if (existing === undefined && head !== "officialPluginFolder") return Effect.fail(unknownKey)
  return Effect.succeed({ ...current, [head]: value })
}

const settingsSet = Command.make(
  "set",
  { values: Argument.String("key=value").pipe(Argument.withDescription("Settings to change"), Argument.variadic({ min: 1 })) },
  ({ values }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.gen(function*() {
        const changes = yield* Input.pairs(values)
        let encoded: unknown = yield* Schema.encodeEffect(SettingsJson)(yield* client.GetSettings()).pipe(Effect.orDie)
        for (const [key, value] of Object.entries(changes)) encoded = yield* setPath(encoded, key.split("."), value)
        const settings = yield* Schema.decodeUnknownEffect(SettingsJson)(encoded).pipe(
          Effect.mapError(() =>
            new Input.InputInvalid({
              message: "A value does not fit its setting. Durations take a form like \"24 hours\", counts a whole number, eventAlerts true or false."
            })
          )
        )
        return yield* client.SetSettings({ settings })
      })
      yield* respond(work, { schema: Settings.Settings, text: Text.settings })
    })
).pipe(Command.withDescription("Change settings, each as key=value, for example limits.backlogCount=30"))

const settings = Command.make("settings", {}, () =>
  Effect.gen(function*() {
    const client = yield* Connection
    yield* respond(client.GetSettings(), { schema: Settings.Settings, text: Text.settings })
  })).pipe(
    Command.withDescription("Show the settings"),
    Command.withSubcommands([settingsSet])
  )

const serviceStatus = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const client = yield* Connection
    yield* respond(client.ServiceStatus(), {
      schema: DaemonContract.ServiceStatus.successSchema,
      text: Text.serviceStatus
    })
  })).pipe(Command.withDescription("Show whether the daemon runs, its version and how it was started"))

const service = Command.make("service").pipe(
  Command.withDescription("The daemon service"),
  Command.withSubcommands([serviceStatus])
)

/** The management commands next to `plugin`, offered to the CLI and never over MCP. */
export const commands = [settings, service] as const
