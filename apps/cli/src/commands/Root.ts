import { Command } from "effect/cli"
import { WakeText } from "@exangelos/contracts"
import * as Agent from "./Agent.ts"
import * as Management from "./Management.ts"
import { Json } from "./Output.ts"

export const make = <
  const Extra extends ReadonlyArray<Command.Command.SubcommandEntry> = readonly [],
  const ExtraConnector extends ReadonlyArray<Command.Command.SubcommandEntry> = readonly []
>(extra: { readonly commands?: Extra; readonly connectorCommands?: ExtraConnector } = {}) => {
  const connector = Command.make("connector").pipe(
    Command.withDescription("Import, enable, disable, remove, configure and dev-link connectors"),
    Command.withSubcommands([...Management.connectorCommands, ...(extra.connectorCommands ?? [])])
  )
  return Command.make(WakeText.command).pipe(
    Command.withDescription("Subscribe to events from external sources and get woken when they happen"),
    Command.withSubcommands([...Agent.commands, connector, ...Management.commands, ...(extra.commands ?? [])]),
    Command.withGlobalFlags([Json])
  )
}

