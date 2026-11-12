import { Effect, Option } from "effect"
import { Command } from "effect/cli"
import { RpcClient } from "effect/rpc"
import { SessionHeaders, WakeText } from "@exangelos/contracts"
import * as Agent from "./Agent.ts"
import * as Management from "./Management.ts"
import { Json } from "./Output.ts"

/**
 * Builds the `exangelos` command tree. `commands` adds top-level commands (such as `daemon` and `mcp`)
 * and `pluginCommands` adds `plugin` subcommands (such as `scaffold`).
 */
export const make = <
  const Extra extends ReadonlyArray<Command.Command.SubcommandEntry> = readonly [],
  const ExtraPlugin extends ReadonlyArray<Command.Command.SubcommandEntry> = readonly []
>(extra: { readonly commands?: Extra; readonly pluginCommands?: ExtraPlugin } = {}) => {
  const plugin = Command.make("plugin").pipe(
    Command.withDescription("Import, enable, disable, remove, configure and dev-link plugins"),
    Command.withSubcommands([...Management.pluginCommands, ...(extra.pluginCommands ?? [])])
  )
  return Command.make(WakeText.command).pipe(
    Command.withDescription("Subscribe to events from external sources and get woken when they happen"),
    Command.withSubcommands([...Agent.commands, plugin, ...Management.commands, ...(extra.commands ?? [])]),
    Command.withGlobalFlags([Json])
  )
}

/** Runs a command with the calling session, detected from `env`, on every daemon call it makes. */
export const withSession = (env: Readonly<Record<string, string | undefined>>) => <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Option.match(SessionHeaders.detect(env), {
    onNone: () => effect,
    onSome: (session) => RpcClient.withHeaders(effect, SessionHeaders.toHeaders(session))
  })
