import { Command } from "effect/cli"
import { WakeText } from "@exangelos/contracts"
import * as Agent from "./Agent.ts"
import * as Management from "./Management.ts"
import { Json } from "./Output.ts"

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

