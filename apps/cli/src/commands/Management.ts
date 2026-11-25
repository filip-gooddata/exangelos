import { Console, Duration, Effect, Option, Path, Redacted, Schema } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/cli"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { CommandHarness, Connector, Session, Settings, Subscription } from "@exangelos/domain"
import * as Text from "../render/Text.ts"
import { Connection } from "./Connection.ts"
import * as Input from "./Input.ts"
import { type Failure, Json, respond } from "./Output.ts"
import * as Secrets from "./Secrets.ts"

const command = WakeText.command

const nameArgument = Argument.String("name").pipe(Argument.withDescription("The connector name"))

const findConnector = (client: Connection["Service"], name: string) =>
  Effect.flatMap(client.ListConnectors(), (all) => {
    const found = all.find((connector) => connector.name === name)
    return found === undefined ? Effect.fail(new DaemonContract.ConnectorNotFound({ connector: name })) : Effect.succeed(found)
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

const importConnector = Command.make(
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
      const work = Effect.flatMap(importSource(source, ref), (resolved) => client.ImportConnector({ source: resolved }))
      yield* respond(work, {
        schema: Connector.Connector,
        text: (connector) =>
          `${Text.connector(connector)}\n\n${connector.name} is inert. Run \`${command} connector enable ${connector.name}\` after checking its origin and checksum.`
      })
    })
).pipe(Command.withDescription("Import a connector; it lands inert"))

const enable = Command.make(
  "enable",
  {
    name: nameArgument,
    digest: Flag.String("digest").pipe(
      Flag.withDescription("Enable without asking, if the connector's checksum is still this one"),
      Flag.optional
    )
  },
  ({ digest, name }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const json = yield* Json
      const work = Effect.gen(function*() {
        const connector = yield* Effect.flatMap(Input.connectorName(name), (valid) => findConnector(client, valid))
        if (Option.isSome(digest)) return yield* client.EnableConnector({ name: connector.name, digest: digest.value })
        if (json) {
          return yield* new Input.InputInvalid({
            message: `Check the origin (${Text.origin(connector.origin)}) and checksum (${connector.digest}) of ${connector.name}, then run \`${command} connector enable ${connector.name} --digest ${connector.digest}\`.`
          })
        }
        yield* Console.log(`Origin:    ${Text.origin(connector.origin)}\nChecksum:  ${connector.digest}`)
        const confirmed = yield* Prompt.Confirm({ message: `Enable ${connector.name}?` }).pipe(
          Effect.catchTag("QuitError", () => Effect.succeed(false))
        )
        if (!confirmed) {
          return yield* new Input.InputInvalid({ message: `${connector.name} was not enabled. It stays inert.` })
        }
        return yield* client.EnableConnector({ name: connector.name, digest: connector.digest })
      })
      yield* respond(work, { schema: Connector.Connector, text: (connector) => `${connector.name} is ${connector.trust}.` })
    })
).pipe(Command.withDescription("Enable a connector after showing its origin and checksum"))

const byName = <A, E extends Failure>(
  name: string,
  description: string,
  call: (client: Connection["Service"], name: Connector.Connector["name"]) => Effect.Effect<A, E>,
  schema: Schema.Codec<A, unknown>,
  text: (value: A, name: string) => string
) =>
  Command.make(name, { name: nameArgument }, (input) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(Input.connectorName(input.name), (valid) => call(client, valid))
      yield* respond(work, { schema, text: (value) => text(value, input.name) })
    })).pipe(Command.withDescription(description))

const disable = byName(
  "disable",
  "Disable a connector; its subscriptions are suspended",
  (client, name) => client.DisableConnector({ name }),
  Connector.Connector,
  (connector) => `${connector.name} is ${connector.trust}.`
)

const remove = byName(
  "remove",
  "Remove a connector",
  (client, name) => client.RemoveConnector({ name }),
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
  { path: Argument.String("path").pipe(Argument.withDescription("The connector's working directory")) },
  ({ path }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const absolute = (yield* Path.Path).resolve(path)
      yield* respond(client.DevLink({ path: absolute }), {
        schema: Connector.Connector,
        text: (connector) => `${connector.name} runs from ${absolute} as dev and restarts when its files change.`
      })
    })
).pipe(Command.withDescription("Trust a connector working directory for development"))

/**
 * The fields the daemon keeps in the secret store. A text field that says where secrets are sent is
 * stored as plain text, and changing it clears the stored secrets, so it is given as key=value.
 */
const secretFieldKeys = (connector: Connector.Connector): Set<string> =>
  new Set(
    (connector.catalogue?.configuration ?? [])
      .filter((field) => field._tag === "Secret")
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
        const name = yield* Input.connectorName(input.name)
        const plain = yield* Input.pairs(input.values)
        const sources = yield* Secrets.sources({
          commands: input.secretCommands,
          files: input.secretFiles,
          prompts: input.secretPrompts
        })
        const connector = yield* findConnector(client, name)
        const secretKeys = secretFieldKeys(connector)
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
        const labels = new Map((connector.catalogue?.configuration ?? []).map((field) => [field.key, field.label]))
        const secrets = yield* Secrets.read(sources, (key) => labels.get(key) ?? key)
        const values: Record<string, string> = { ...plain }
        for (const [key, value] of secrets) values[key] = Redacted.value(value)
        const revealed = secrets.map(([, value]) => Redacted.value(value))
        return yield* client.ConfigureConnector({ name, values }).pipe(
          Effect.mapError((failure) => Secrets.scrub(failure, revealed))
        )
      })
      yield* respond(work, {
        schema: Connector.Connector,
        text: (connector) => `${connector.name} is configured.`
      })
    })
).pipe(Command.withDescription("Configure a connector; secret fields come from a command, a file or a hidden prompt"))

export const connectorCommands = [importConnector, enable, disable, remove, configure, devLink, devUnlink] as const

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
  if (existing === undefined && head !== "officialConnectorFolder" && head !== "logLevel") return Effect.fail(unknownKey)
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
              message: "A value does not fit its setting. Durations take a form like \"24 hours\", counts a whole number, eventAlerts true or false, logLevel one of error, warn, info, debug, trace."
            })
          )
        )
        return yield* client.SetSettings({ settings })
      })
      yield* respond(work, { schema: Settings.Settings, text: Text.settings })
    })
).pipe(Command.withDescription("Change settings, each as key=value, for example limits.backlogCount=30"))

const harnessName = (name: string) =>
  Schema.is(Session.HarnessName)(name)
    ? Effect.succeed(name)
    : Effect.fail(
      new Input.InputInvalid({
        message: `A harness name is lowercase letters, digits and dashes, starts with a letter, has at most 32 characters, and is not t3, codex or claude-code. ${JSON.stringify(name)} is not one.`
      })
    )

const harnessSet = Command.make(
  "set",
  {
    name: Argument.String("name").pipe(Argument.withDescription("The harness name a subscription's wake target uses")),
    command: Argument.String("program-and-args").pipe(
      Argument.withDescription("The program to run and its arguments; {session} and {subscription} in an argument become the target's values"),
      Argument.variadic({ min: 1 })
    )
  },
  ({ name, command }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.gen(function*() {
        const checked = yield* harnessName(name)
        const problem = CommandHarness.problem(command)
        if (problem !== undefined) return yield* new Input.InputInvalid({ message: `The command does not work as a harness: ${problem}.` })
        return yield* client.SetHarness({ name: checked, command })
      })
      yield* respond(work, { schema: Settings.Settings, text: Text.settings })
    })
).pipe(
  Command.withDescription(
    "Define a harness, or replace the one of that name. On each wake the daemon runs the program without a shell and passes the wake text on stdin. Put -- before the program when an argument starts with -, for example: settings harness set relay -- /usr/local/bin/relay --session {session}"
  )
)

const harnessRemove = Command.make(
  "remove",
  { name: Argument.String("name").pipe(Argument.withDescription("The harness to remove")) },
  ({ name }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(harnessName(name), (checked) => client.RemoveHarness({ name: checked }))
      yield* respond(work, { schema: Settings.Settings, text: Text.settings })
    })
).pipe(Command.withDescription("Remove a harness. Wakes for subscriptions that use it fail until you define it again."))

const harness = Command.make("harness").pipe(
  Command.withDescription("Define or remove the harnesses that wake sessions through a command of yours"),
  Command.withSubcommands([harnessSet, harnessRemove])
)

const settings = Command.make("settings", {}, () =>
  Effect.gen(function*() {
    const client = yield* Connection
    yield* respond(client.GetSettings(), { schema: Settings.Settings, text: Text.settings })
  })).pipe(
    Command.withDescription("Show the settings"),
    Command.withSubcommands([settingsSet, harness])
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

const alerts = Command.make(
  "alerts",
  {
    subscription: Argument.String("subscription").pipe(
      Argument.withDescription("The subscription id, for example sub_7f3k")
    ),
    eventAlerts: Argument.ChoiceWithValue("on|off", [["on", true], ["off", false]] as const).pipe(
      Argument.withDescription("Whether each event on this subscription also shows a notification")
    )
  },
  ({ eventAlerts, subscription }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(Input.subscriptionId(subscription), (id) => client.SetEventAlerts({ id, eventAlerts }))
      yield* respond(work, { schema: Subscription.Subscription, text: Text.subscription, subscription })
    })
).pipe(Command.withDescription("Turn event notifications for one subscription on or off"))

export const commands = [settings, service, alerts] as const
