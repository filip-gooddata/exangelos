import { Config, Context, Effect, Layer, Option, Schema } from "effect"

export const socketPathLimit = 103

export class SocketPathTooLong extends Schema.TaggedError<SocketPathTooLong>()("SocketPathTooLong", {
  path: Schema.String,
  limit: Schema.Int
}) {}

export class Paths extends Context.Service<Paths, {
  readonly configDir: string
  readonly dataDir: string
  readonly stateDir: string
  readonly settingsFile: string
  readonly secretsFile: string
  readonly databaseFile: string
  readonly connectorDir: string
  readonly socketPath: string
  readonly logDir: string
  readonly logFile: string
}>()("@exangelos/paths/Paths") {}

const optional = (name: string) => Config.option(Config.NonEmptyString(name))

const xdg = (home: string, variable: string, fallback: string) =>
  Config.map(optional(variable), (dir) => `${Option.getOrElse(dir, () => `${home}/${fallback}`)}/exangelos`)

const directories = Effect.gen(function*() {
  const single = yield* optional("EXANGELOS_HOME")
  if (Option.isSome(single)) return { config: single.value, data: single.value, state: single.value }
  const home = yield* Config.NonEmptyString("HOME")
  return {
    config: yield* xdg(home, "XDG_CONFIG_HOME", ".config"),
    data: yield* xdg(home, "XDG_DATA_HOME", ".local/share"),
    state: yield* xdg(home, "XDG_STATE_HOME", ".local/state")
  }
})

const utf8Length = (text: string) =>
  Array.from(text).reduce((bytes, char) => {
    const point = char.codePointAt(0) ?? 0
    return bytes + (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4)
  }, 0)

export const make = Effect.gen(function*() {
  const dirs = yield* directories
  const socketPath = `${dirs.state}/daemon.sock`
  if (utf8Length(socketPath) > socketPathLimit) {
    return yield* new SocketPathTooLong({ path: socketPath, limit: socketPathLimit })
  }
  return Paths.of({
    configDir: dirs.config,
    dataDir: dirs.data,
    stateDir: dirs.state,
    settingsFile: `${dirs.config}/settings.json`,
    secretsFile: `${dirs.data}/secrets.json`,
    databaseFile: `${dirs.data}/exangelos.db`,
    connectorDir: `${dirs.data}/connectors`,
    socketPath,
    logDir: `${dirs.state}/logs`,
    logFile: `${dirs.state}/logs/daemon.log`
  })
})

export const layer = Layer.effect(Paths, make)
